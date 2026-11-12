// 小羊長大日記 — Supabase Edge Function 版（從 PythonAnywhere 版的 app.py 改寫成 TypeScript）
// 網頁放在 GitHub Pages，所有資料動作都 POST 到這個函式：{ action, token, data }
// 管理後台：{ action: "admin…", data }；排程（pg_cron 每 5 分鐘）：{ cron: "land", key }
import postgres from "npm:postgres@3.4.5";
import webpush from "npm:web-push@3.6.7";

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
// deno-lint-ignore no-explicit-any
type Db = any;
type Ctx = { db: Db; push: [number[], Row][] };

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 4, idle_timeout: 20 });

const MAX_SCORE = 500;
const TEAM_SIZE = 3;
const MAX_BODY = 1_000_000;

// 五個加分按鈕
const ACTIVITIES: Record<string, Row> = {
  sunday: { label: "參加週日聚會", points: 10, icon: "⛪", per: "week" },
  call: { label: "每天呼求主名", points: 1, icon: "🙌" },
  bible: { label: "讀一章聖經", points: 3, icon: "📖" },
  group: { label: "參加小排聚會", points: 8, icon: "🏠", per: "week" },
  prayer: { label: "每天禱告3分鐘", points: 3, icon: "🙏" },
};

// 抽獎獎品：神全副的軍裝（以弗所書 6:13-17）
const PRIZES: [string, string][] = [
  ["belt", "真理的腰帶"], ["breastplate", "義的胸甲"], ["shoes", "福音的鞋"],
  ["shield", "信的盾牌"], ["helmet", "救恩的頭盔"], ["sword", "那靈的劍"],
];
const PRIZE_KEYS = PRIZES.map(([k]) => k);
const PRIZE_NAME = Object.fromEntries(PRIZES);
// 各隻羊已經有的專屬裝備圖（網頁 armor/s1 ~ s6）；新增圖片時也要改這裡
const ARMOR_SETS: Record<string, string[]> = {
  "1": ["belt", "breastplate", "shoes", "shield", "helmet", "sword"],
  "2": ["belt", "breastplate", "shoes", "shield", "helmet"],
  "3": ["belt", "breastplate", "shoes", "helmet"],
  "4": ["belt", "breastplate", "shoes", "helmet"],
  "5": ["belt", "breastplate", "shoes", "helmet"],
  "6": ["belt", "breastplate", "shoes", "helmet"],
};

// 美地植物：一天的欄位全部填好，就隨機得到一株（先從組裡這週還沒有的種類抽）
const PLANTS: [string, string][] = [
  ["grass", "青草"], ["daisybush", "小白花叢"], ["broadleaf", "闊葉草"], ["reed", "蘆葦"], ["yellowgrass", "黃花草"],
  ["clover", "幸運草"], ["longgrass", "長葉草"], ["whitebush", "白花灌木"], ["lavender", "薰衣草"], ["yellowbush", "黃花矮叢"],
  ["daisy", "雛菊"], ["sunflower", "向日葵"], ["tulip", "鬱金香"], ["hydrangea", "繡球花"], ["lily", "百合花"],
  ["blossom", "櫻花枝"], ["bellflower", "風鈴草"], ["rose", "玫瑰"], ["marigold", "金盞花"], ["morningglory", "牽牛花"],
  ["greentree", "大樹"], ["sakura", "櫻花樹"], ["pine", "松樹"], ["apple", "蘋果樹"], ["willow", "柳樹"],
  ["ginkgo", "銀杏樹"], ["palm", "椰子樹"], ["birch", "白樺樹"], ["jacaranda", "藍花楹"], ["banyan", "榕樹"],
];
const PLANT_NAME = Object.fromEntries(PLANTS);

const STAGES: [number, string][] = [[400, "榮耀羊"], [300, "得勝羊"], [200, "剛強羊"], [100, "大肥羊"], [50, "喜羊羊"], [0, "小羊羔"]];

// ---------------------------------------------------------------- 時間（台灣時間，主機是 UTC）
const tw = (ms = Date.now()) => new Date(ms + 8 * 3600e3); // 之後只用 getUTC* / toISOString 讀
const now = () => tw().toISOString().slice(0, 19);
const today = () => now().slice(0, 10);
function weekStart() {
  const d = tw();
  return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86400e3).toISOString().slice(0, 10);
}
const stageOf = (score: number) => (STAGES.find(([low]) => score >= low) ?? STAGES[STAGES.length - 1])[1];
const choice = <T>(a: T[]) => a[crypto.getRandomValues(new Uint32Array(1))[0] % a.length];
const isObj = (v: unknown): v is Row => typeof v === "object" && v !== null && !Array.isArray(v);

class ApiError extends Error {
  constructor(msg: string, public status = 400) { super(msg); }
}

// ---------------------------------------------------------------- 手機推播
// 只接受各大瀏覽器的推播伺服器，避免被拿來亂連其他網址
const PUSH_HOSTS = ["fcm.googleapis.com", ".push.apple.com", "updates.push.services.mozilla.com", ".notify.windows.com"];
const MAX_SUBS_PER_USER = 10;
let vapid: { publicKey: string; privateKey: string } | null = null;

// 推播金鑰存在 lamb.config，第一次用到時自動產生
async function pushKeys() {
  if (vapid) return vapid;
  let rows = await sql`select key, value from lamb.config where key in ('vapid_public', 'vapid_private')`;
  if (rows.length < 2) {
    const k = webpush.generateVAPIDKeys();
    await sql`insert into lamb.config (key, value) values ('vapid_public', ${k.publicKey}), ('vapid_private', ${k.privateKey})
              on conflict (key) do nothing`;
    rows = await sql`select key, value from lamb.config where key in ('vapid_public', 'vapid_private')`;
  }
  const m = Object.fromEntries(rows.map((r: Row) => [r.key, r.value]));
  vapid = { publicKey: m.vapid_public, privateKey: m.vapid_private };
  return vapid;
}

function queuePush(c: Ctx, userIds: number[], title: string, body: string, url = "./", tag: string | null = null) {
  userIds = userIds.filter(Boolean);
  if (userIds.length) c.push.push([userIds, { title, body, url, tag }]);
}

// 送通知給這些人的所有手機，回傳成功送出的數量；失效的手機會自動移除
async function sendPush(userIds: number[], payload: Row) {
  if (!userIds.length) return 0;
  const keys = await pushKeys();
  const subs = await sql`select * from lamb.push_subs where user_id in ${sql(userIds)}`;
  const results = await Promise.all(subs.map(async (s: Row) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { vapidDetails: { subject: "https://github.com/PaulWu722", ...keys }, TTL: 12 * 3600, timeout: 6000 },
      );
      return 1;
    } catch (e) {
      const status = (e as Row).statusCode;
      if (status === 404 || status === 410) await sql`delete from lamb.push_subs where endpoint = ${s.endpoint}`; // 對方已經關掉通知或換手機
      else console.error("PUSH ERROR", status, String(e).slice(0, 300));
      return 0;
    }
  }));
  return results.reduce((a: number, b: number) => a + b, 0);
}

async function flushPush(box: Ctx["push"]) {
  for (const [ids, payload] of box) {
    try { await sendPush(ids, payload); } catch (e) { console.error("PUSH ERROR", String(e).slice(0, 300)); } // 通知失敗不能影響原本的動作
  }
}

const teammates = async (db: Db, teamId: number, exclude?: number) =>
  (await db`select id from lamb.users where team_id = ${teamId}`).map((r: Row) => r.id).filter((i: number) => i !== exclude);

// ---------------------------------------------------------------- 共用邏輯
async function userByToken(db: Db, token: string) {
  if (!token) return null;
  return (await db`select u.* from lamb.sessions s join lamb.users u on u.id = s.user_id where s.token = ${token}`)[0] ?? null;
}

async function requireUser(db: Db, token: string) {
  const u = await userByToken(db, token);
  if (!u) throw new ApiError("請先登入", 401);
  return u;
}

// 組員這週（週一到週日）在美地種下的植物，每週一重新開始（舊的紀錄還留在資料庫）
async function teamPlants(db: Db, teamId: number) {
  const rows = await db`select p.plant from lamb.user_plants p join lamb.users u on u.id = p.user_id
                        where u.team_id = ${teamId} and p.day >= ${weekStart()} order by p.created_at, p.user_id`;
  return { plants: rows.map((r: Row) => r.plant), plantCount: rows.length };
}

async function teamPrizes(db: Db, teamId: number) {
  const owned = new Set((await db`select prize from lamb.team_prizes where team_id = ${teamId}`).map((r: Row) => r.prize));
  return PRIZE_KEYS.filter((k) => owned.has(k));
}

async function teamPayload(db: Db, teamId: number, meId?: number) {
  const t = (await db`select * from lamb.teams where id = ${teamId}`)[0];
  if (!t) return null;
  const data: Row = {
    id: t.id, name: t.name, avatar: t.avatar, score: t.score, stage: stageOf(t.score),
    prizes: await teamPrizes(db, t.id),
    ...await teamPlants(db, t.id),
    members: (await db`select id, name from lamb.users where team_id = ${teamId} order by id`).map((r: Row) => ({ id: r.id, name: r.name })),
  };
  if (meId !== undefined) {
    data.doneToday = (await db`select activity from lamb.checkins where user_id = ${meId} and day = ${today()}`).map((r: Row) => r.activity);
    // 每週一次的項目：這週已經按過就算完成
    const weekly = Object.keys(ACTIVITIES).filter((k) => ACTIVITIES[k].per === "week");
    data.doneWeek = (await db`select distinct activity from lamb.checkins
                              where user_id = ${meId} and day >= ${weekStart()} and activity in ${db(weekly)}`).map((r: Row) => r.activity);
    data.recent = (await db`select u.name, c.activity, c.points, c.created_at from lamb.checkins c join lamb.users u on u.id = c.user_id
                            where c.team_id = ${teamId} order by c.id desc limit 15`)
      .map((r: Row) => ({ name: r.name, activity: r.activity, points: r.points, at: r.created_at }));
  }
  return data;
}

function validateAvatar(a: unknown) {
  if (typeof a !== "string" || !a) throw new ApiError("請選擇頭像");
  if (a.startsWith("data:image/")) {
    if (a.length > 200_000) throw new ApiError("頭像圖片太大，請換一張");
  } else if (a.length > 16) throw new ApiError("頭像格式不正確");
  return a;
}

function validateTeamName(n: unknown) {
  const s = String(n || "").trim();
  if (s.length < 1 || s.length > 20) throw new ApiError("組別名稱需為 1～20 個字");
  return s;
}

async function newSession(db: Db, userId: number) {
  const token = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  await db`insert into lamb.sessions (token, user_id, created_at) values (${token}, ${userId}, ${now()})`;
  return token;
}

const inviteMembers = (db: Db, inviteId: number) =>
  db`select m.user_id, m.accepted, u.name, u.team_id from lamb.invite_members m
     join lamb.users u on u.id = m.user_id where m.invite_id = ${inviteId} order by m.pos`;

async function inviteView(db: Db, inv: Row, meId: number) {
  const members = await inviteMembers(db, inv.id);
  const inviter = (await db`select name from lamb.users where id = ${inv.inviter_id}`)[0];
  return {
    id: inv.id, inviter: inviter ? inviter.name : "", teamName: inv.team_name, avatar: inv.avatar, status: inv.status, note: inv.note,
    iAccepted: members.some((m: Row) => m.user_id === meId && m.accepted),
    members: members.map((m: Row) => ({ id: m.user_id, name: m.name, accepted: !!m.accepted })),
  };
}

// 還沒有組別的人看到的「找同伴」畫面資料
async function lobby(db: Db, me: Row) {
  const incoming = await db`select i.* from lamb.invites i join lamb.invite_members m on m.invite_id = i.id
                            where i.status = 'pending' and m.user_id = ${me.id} and i.inviter_id != ${me.id} order by i.id`;
  const outgoing = (await db`select * from lamb.invites where inviter_id = ${me.id} and status in ('pending', 'declined', 'voided')
                             order by id desc limit 1`)[0];
  const unassigned = await db`select id, name, phone from lamb.users where team_id is null and id != ${me.id} order by id`;
  return {
    incoming: await Promise.all(incoming.map((i: Row) => inviteView(db, i, me.id))),
    outgoing: outgoing ? await inviteView(db, outgoing, me.id) : null,
    // 手機號碼只顯示末三碼，保護隱私
    unassigned: unassigned.map((u: Row) => ({ id: u.id, name: u.name, phoneTail: u.phone.slice(-3) })),
  };
}

async function myInvite(db: Db, me: Row, inviteId: unknown, statuses: string[]) {
  const id = Number(inviteId);
  const inv = Number.isInteger(id) ? (await db`select * from lamb.invites where id = ${id} and inviter_id = ${me.id}`)[0] : null;
  if (!inv || !statuses.includes(inv.status)) throw new ApiError("找不到這個邀請");
  return inv;
}

// ---------------------------------------------------------------- API
async function actMe({ db }: Ctx, token: string) {
  const config = { activities: ACTIVITIES, stages: STAGES, maxScore: MAX_SCORE, armorSets: ARMOR_SETS, plants: PLANTS };
  const u = await userByToken(db, token);
  if (!u) return { config, user: null, team: null };
  return {
    config,
    user: { id: u.id, name: u.name, phone: u.phone },
    team: u.team_id ? await teamPayload(db, u.team_id, u.id) : null,
    lobby: u.team_id ? null : await lobby(db, u),
    unread: await unreadCount(db, u),
    missionAlert: await missionAlert(db, u),
  };
}

// 只用手機號碼進入：已註冊就直接登入；還沒註冊則需要暱稱，建立新帳號
async function actEnter({ db }: Ctx, _t: string, d: Row) {
  const phone = String(d.phone ?? "").replace(/[\s-]/g, "");
  if (!/^09\d{8}$/.test(phone)) throw new ApiError("請輸入正確的手機號碼（例：0912345678）");
  const u = (await db`select id from lamb.users where phone = ${phone}`)[0];
  if (u) return { token: await newSession(db, u.id) };
  const name = String(d.name ?? "").trim();
  if (!name) return { needName: true };
  if (name.length > 12) throw new ApiError("暱稱最多 12 個字");
  const [r] = await db`insert into lamb.users (phone, name, created_at) values (${phone}, ${name}, ${now()}) returning id`;
  return { token: await newSession(db, r.id) };
}

async function actLogout({ db }: Ctx, token: string, d: Row) {
  const u = await userByToken(db, token);
  if (u && d.endpoint) await db`delete from lamb.push_subs where endpoint = ${String(d.endpoint)} and user_id = ${u.id}`; // 登出後這支手機就不再收到這個人的通知
  await db`delete from lamb.sessions where token = ${token}`;
  return { ok: true };
}

// 邀請 2 位還沒有組別的人一起組隊（邀請人自動算同意）
async function actInvite(c: Ctx, token: string, d: Row) {
  const db = c.db;
  const me = await requireUser(db, token);
  if (me.team_id) throw new ApiError("你已經有組別了");
  const name = validateTeamName(d.name);
  const avatar = validateAvatar(d.avatar);
  const ids: number[] = [];
  for (const i of Array.isArray(d.memberIds) ? d.memberIds : []) {
    if (/^\d+$/.test(String(i)) && Number(i) !== me.id && !ids.includes(Number(i))) ids.push(Number(i));
  }
  if (ids.length !== TEAM_SIZE - 1) throw new ApiError("一組需要 3 個人，請選擇 2 位同伴");
  for (const uid of ids) {
    const m = (await db`select name, team_id from lamb.users where id = ${uid}`)[0];
    if (!m) throw new ApiError("找不到這位同伴");
    if (m.team_id) throw new ApiError(`${m.name} 已經加入其他組別了`);
  }
  if ((await db`select 1 from lamb.invites where inviter_id = ${me.id} and status = 'pending'`).length) {
    throw new ApiError("你已經有一個邀請在等待回覆，請先取消再重新邀請");
  }
  await db`update lamb.invites set status = 'closed' where inviter_id = ${me.id} and status in ('declined', 'voided')`;
  const [inv] = await db`insert into lamb.invites (inviter_id, team_name, avatar, status, created_at)
                         values (${me.id}, ${name}, ${avatar}, 'pending', ${now()}) returning id`;
  const all = [me.id, ...ids];
  for (let pos = 0; pos < all.length; pos++) {
    await db`insert into lamb.invite_members (invite_id, user_id, pos, accepted) values (${inv.id}, ${all[pos]}, ${pos}, ${all[pos] === me.id ? 1 : 0})`;
  }
  queuePush(c, ids, `📬 ${me.name} 邀請你組隊`, `組別「${name}」，打開 App 按「同意」就能一起養小羊！`, "./", `invite-${inv.id}`);
  return { lobby: await lobby(db, me) };
}

// 回覆邀請：三個人都同意就正式組隊
async function actRespondInvite(c: Ctx, token: string, d: Row) {
  const db = c.db;
  const me = await requireUser(db, token);
  if (me.team_id) throw new ApiError("你已經有組別了");
  const id = Number(d.inviteId);
  const inv = Number.isInteger(id) ? (await db`select * from lamb.invites where id = ${id}`)[0] : null;
  if (!inv || inv.status !== "pending") throw new ApiError("這個邀請已經失效了");
  if (!(await db`select 1 from lamb.invite_members where invite_id = ${inv.id} and user_id = ${me.id}`).length) {
    throw new ApiError("這個邀請不是給你的");
  }
  if (!d.accept) {
    await db`update lamb.invites set status = 'declined', note = ${me.name + " 拒絕了邀請"} where id = ${inv.id}`;
    return { lobby: await lobby(db, me) };
  }
  await db`update lamb.invite_members set accepted = 1 where invite_id = ${inv.id} and user_id = ${me.id}`;
  const members = await inviteMembers(db, inv.id);
  if (!members.every((m: Row) => m.accepted)) return { lobby: await lobby(db, me) };

  // 三個人都同意了
  const taken = members.filter((m: Row) => m.team_id).map((m: Row) => m.name);
  if (taken.length) {
    await db`update lamb.invites set status = 'voided', note = ${taken.join("、") + " 已加入其他組別"} where id = ${inv.id}`;
    return { lobby: await lobby(db, me), message: "有同伴已經加入其他組別，這個邀請失效了" };
  }
  const [team] = await db`insert into lamb.teams (name, avatar, score, created_at) values (${inv.team_name}, ${inv.avatar}, 0, ${now()}) returning id`;
  const ids: number[] = members.map((m: Row) => m.user_id);
  await db`update lamb.users set team_id = ${team.id} where id in ${db(ids)}`;
  await db`update lamb.invites set status = 'done' where id = ${inv.id}`;

  // 這三個人參與的其他邀請都失效
  const others = await db`select distinct i.id from lamb.invites i join lamb.invite_members m on m.invite_id = i.id
                          where i.status = 'pending' and m.user_id in ${db(ids)}`;
  for (const o of others) {
    const names = (await db`select u.name from lamb.invite_members m join lamb.users u on u.id = m.user_id
                            where m.invite_id = ${o.id} and m.user_id in ${db(ids)} order by m.pos`).map((r: Row) => r.name);
    await db`update lamb.invites set status = 'voided', note = ${names.join("、") + " 已加入其他組別"} where id = ${o.id}`;
  }
  queuePush(c, ids.filter((i) => i !== me.id), "🎉 組隊成功！", `「${inv.team_name}」三隻羊羊到齊了，開始一起養小羊吧！`, "./", "team");
  return { formed: true };
}

async function actCancelInvite({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  const inv = await myInvite(db, me, d.inviteId, ["pending"]);
  await db`update lamb.invites set status = 'cancelled' where id = ${inv.id}`;
  return { lobby: await lobby(db, me) };
}

// 邀請人看過「被拒絕／失效」的通知後關掉
async function actDismissInvite({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  const inv = await myInvite(db, me, d.inviteId, ["declined", "voided"]);
  await db`update lamb.invites set status = 'closed' where id = ${inv.id}`;
  return { lobby: await lobby(db, me) };
}

async function actUpdateTeam({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  if (!me.team_id) throw new ApiError("你還沒有組別");
  await db`update lamb.teams set name = ${validateTeamName(d.name)}, avatar = ${validateAvatar(d.avatar)} where id = ${me.team_id}`;
  return { team: await teamPayload(db, me.team_id, me.id) };
}

function activityOf(key: unknown) {
  const act = typeof key === "string" && Object.hasOwn(ACTIVITIES, key) ? ACTIVITIES[key] : null;
  if (!act) throw new ApiError("沒有這個項目");
  return act;
}

async function actCheckin(c: Ctx, token: string, d: Row) {
  const db = c.db;
  const me = await requireUser(db, token);
  if (!me.team_id) throw new ApiError("請先組隊");
  const key = d.activity as string;
  const act = activityOf(key);
  const day = today();
  if (act.per === "week") {
    if ((await db`select 1 from lamb.checkins where user_id = ${me.id} and activity = ${key} and day >= ${weekStart()}`).length) {
      throw new ApiError(`本週已經記錄過「${act.label}」囉！下週一就可以再按`);
    }
  } else if ((await db`select 1 from lamb.checkins where user_id = ${me.id} and activity = ${key} and day = ${day}`).length) {
    throw new ApiError(`今天已經記錄過「${act.label}」囉！`);
  }
  const old = (await db`select score from lamb.teams where id = ${me.team_id}`)[0].score;
  const neu = Math.min(MAX_SCORE, old + act.points);
  await db`insert into lamb.checkins (user_id, team_id, activity, day, points, created_at)
           values (${me.id}, ${me.team_id}, ${key}, ${day}, ${neu - old}, ${now()})`;
  await db`update lamb.teams set score = ${neu} where id = ${me.team_id}`;
  const team = (await teamPayload(db, me.team_id, me.id))!;
  const others = await teammates(db, me.team_id, me.id);
  queuePush(c, others, `✅ ${me.name}：${act.label}`, `「${team.name}」+${neu - old} 分，目前 ${neu} 分`, "./", `checkin-${me.id}-${key}`);
  const evolved = stageOf(neu) !== stageOf(old);
  if (evolved && neu > old) queuePush(c, [...others, me.id], "🐑 小羊進化了！", `「${team.name}」的小羊變成「${stageOf(neu)}」了 ✨`, "./", "evolve");
  return { team, gained: neu - old, evolved };
}

// 按錯了：取消今天自己按過的某一項，扣回當時加的分數
async function actUncheckin({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  if (!me.team_id) throw new ApiError("請先組隊");
  const key = d.activity as string;
  const act = activityOf(key);
  const ck = (await db`select id, points, team_id from lamb.checkins where user_id = ${me.id} and activity = ${key} and day = ${today()}`)[0];
  if (!ck) throw new ApiError(`今天沒有記錄過「${act.label}」，或已經過了可以取消的時間`);
  const old = (await db`select score from lamb.teams where id = ${ck.team_id}`)[0].score;
  const neu = Math.max(0, old - ck.points);
  await db`delete from lamb.checkins where id = ${ck.id}`;
  await db`update lamb.teams set score = ${neu} where id = ${ck.team_id}`;
  return { team: await teamPayload(db, me.team_id, me.id), removed: old - neu };
}

const CHAT_MAX_LEN = 300;
const messageView = (m: Row) => ({ id: m.id, userId: m.user_id, name: m.name, body: m.body, at: m.created_at });

// 組內聊天：沒有 afterId 時回傳最近 50 則；有的話只回傳比它新的訊息
async function actChatList({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  if (!me.team_id) throw new ApiError("請先組隊");
  const after = d.afterId;
  const rows = Number.isInteger(after) && after > 0
    ? await db`select m.*, u.name from lamb.messages m join lamb.users u on u.id = m.user_id
               where m.team_id = ${me.team_id} and m.id > ${after} order by m.id limit 100`
    : await db`select * from (select m.*, u.name from lamb.messages m join lamb.users u on u.id = m.user_id
               where m.team_id = ${me.team_id} order by m.id desc limit 50) x order by id`;
  return { messages: rows.map(messageView) };
}

async function actChatSend(c: Ctx, token: string, d: Row) {
  const db = c.db;
  const me = await requireUser(db, token);
  if (!me.team_id) throw new ApiError("請先組隊");
  const body = String(d.body || "").trim();
  if (!body) throw new ApiError("請輸入訊息");
  if (body.length > CHAT_MAX_LEN) throw new ApiError(`訊息最多 ${CHAT_MAX_LEN} 個字`);
  const [r] = await db`insert into lamb.messages (team_id, user_id, body, created_at) values (${me.team_id}, ${me.id}, ${body}, ${now()}) returning id`;
  const m = (await db`select m.*, u.name from lamb.messages m join lamb.users u on u.id = m.user_id where m.id = ${r.id}`)[0];
  const teamName = (await db`select name from lamb.teams where id = ${me.team_id}`)[0].name;
  const short = body.length <= 80 ? body : body.slice(0, 80) + "…";
  queuePush(c, await teammates(db, me.team_id, me.id), `💬 ${teamName}`, `${me.name}：${short}`, "./#chat", `chat-${me.team_id}`);
  return { message: messageView(m) };
}

// 同組其他人傳的、我還沒看過的訊息數
async function unreadCount(db: Db, u: Row) {
  if (!u.team_id) return 0;
  return (await db`select count(*)::int as n from lamb.messages where team_id = ${u.team_id} and user_id != ${u.id}
                   and id > coalesce((select last_id from lamb.chat_reads where user_id = ${u.id}), 0)`)[0].n;
}

// 進行中、還沒到期的任務（同時只有一個）
const activeMission = async (db: Db) =>
  (await db`select * from lamb.missions where status = 'active' and ends_at > ${now()} order by id desc limit 1`)[0] ?? null;

const unusedTickets = async (db: Db, teamId: number) =>
  (await db`select count(*)::int as n from lamb.tickets where team_id = ${teamId} and used_at is null`)[0].n;

// 分頁上的提醒點：有任務我還沒完成，或有抽獎券還沒用
async function missionAlert(db: Db, u: Row) {
  if (!u.team_id) return false;
  const m = await activeMission(db);
  if (m && !(await db`select 1 from lamb.mission_done where mission_id = ${m.id} and user_id = ${u.id}`).length) return true;
  return (await unusedTickets(db, u.team_id)) > 0;
}

async function missionState(db: Db, me: Row) {
  const out: Row = { prizeList: PRIZES.map(([key, name]) => ({ key, name })), mission: null, tickets: 0, prizes: [] };
  const m = await activeMission(db);
  if (m) {
    const info: Row = {
      id: m.id, title: m.title, endsAt: m.ends_at,
      secondsLeft: Math.max(0, Math.floor((Date.parse(m.ends_at + "+08:00") - Date.now()) / 1000)),
    };
    if (me.team_id) {
      const done = new Set((await db`select user_id from lamb.mission_done where mission_id = ${m.id}`).map((r: Row) => r.user_id));
      const members = await db`select id, name from lamb.users where team_id = ${me.team_id} order by id`;
      info.members = members.map((u: Row) => ({ name: u.name, done: done.has(u.id) }));
      info.iDone = done.has(me.id);
      info.teamDone = (await db`select 1 from lamb.tickets where team_id = ${me.team_id} and mission_id = ${m.id}`).length > 0;
    }
    out.mission = info;
  }
  if (me.team_id) {
    out.tickets = await unusedTickets(db, me.team_id);
    out.prizes = await teamPrizes(db, me.team_id);
  }
  return out;
}

async function actMissionState({ db }: Ctx, token: string) {
  return missionState(db, await requireUser(db, token));
}

// 我完成任務了；全組都完成就得到一張抽獎券
async function actMissionDone(c: Ctx, token: string, d: Row) {
  const db = c.db;
  const me = await requireUser(db, token);
  if (!me.team_id) throw new ApiError("組隊之後才能出任務喔");
  const m = await activeMission(db);
  if (!m || m.id !== d.missionId) throw new ApiError("這個任務已經結束了");
  await db`insert into lamb.mission_done (mission_id, user_id, done_at) values (${m.id}, ${me.id}, ${now()}) on conflict do nothing`;
  const members: number[] = (await db`select id from lamb.users where team_id = ${me.team_id}`).map((r: Row) => r.id);
  const done = new Set((await db`select user_id from lamb.mission_done where mission_id = ${m.id}`).map((r: Row) => r.user_id));
  let gotTicket = false;
  if (members.every((i) => done.has(i))) {
    gotTicket = (await db`insert into lamb.tickets (team_id, mission_id, created_at) values (${me.team_id}, ${m.id}, ${now()})
                          on conflict do nothing returning id`).length > 0;
  }
  if (gotTicket) queuePush(c, members, "🎟️ 全組完成任務！", `「${m.title}」完成了，獲得一張抽獎券，快去抽裝備吧！`, "./", "ticket");
  else queuePush(c, members.filter((i) => i !== me.id), `🎯 ${me.name} 完成了任務`, `「${m.title}」還差你喔！`, "./", `mission-${m.id}`);
  return { ...await missionState(db, me), gotTicket };
}

// 用一張抽獎券抽一個裝備（先從還沒有的裝備裡抽）
async function actSpin(c: Ctx, token: string) {
  const db = c.db;
  const me = await requireUser(db, token);
  if (!me.team_id) throw new ApiError("組隊之後才能抽獎喔");
  const t = (await db`select id from lamb.tickets where team_id = ${me.team_id} and used_at is null order by id limit 1`)[0];
  if (!t) throw new ApiError("還沒有抽獎券，全組完成任務就能得到");
  const owned = new Set(await teamPrizes(db, me.team_id));
  const pool = PRIZE_KEYS.filter((k) => !owned.has(k));
  const prize = choice(pool.length ? pool : PRIZE_KEYS);
  await db`update lamb.tickets set used_at = ${now()}, prize = ${prize} where id = ${t.id}`;
  await db`insert into lamb.team_prizes (team_id, prize, created_at) values (${me.team_id}, ${prize}, ${now()}) on conflict do nothing`;
  queuePush(c, await teammates(db, me.team_id, me.id), `🛡️ 抽到「${PRIZE_NAME[prize]}」！`, `${me.name} 幫小組抽到了新裝備，羊羊已經穿上囉`, "./", "prize");
  return { ...await missionState(db, me), prize, index: PRIZE_KEYS.indexOf(prize), duplicate: owned.has(prize) };
}

async function actChatUnread({ db }: Ctx, token: string) {
  const u = await requireUser(db, token);
  return { unread: await unreadCount(db, u), missionAlert: await missionAlert(db, u) };
}

// 看過聊天室了：記下看到哪一則
async function actChatRead({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  const last = d.lastId;
  if (me.team_id && Number.isInteger(last) && last > 0) {
    const top = (await db`select coalesce(max(id), 0) as top from lamb.messages where team_id = ${me.team_id}`)[0].top;
    await db`insert into lamb.chat_reads (user_id, last_id) values (${me.id}, ${Math.min(last, top)})
             on conflict (user_id) do update set last_id = greatest(lamb.chat_reads.last_id, excluded.last_id)`;
  }
  return { unread: await unreadCount(db, me) };
}

async function actPushKey({ db }: Ctx, token: string) {
  await requireUser(db, token);
  return { publicKey: (await pushKeys()).publicKey };
}

// 把這支手機的通知設定綁到目前登入的人
async function actPushSubscribe({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  const sub = isObj(d.subscription) ? d.subscription : {};
  const keys = isObj(sub.keys) ? sub.keys : {};
  const endpoint = String(sub.endpoint || ""), p256dh = String(keys.p256dh || ""), auth = String(keys.auth || "");
  let host = "";
  try { host = new URL(endpoint).hostname; } catch { /* 下面會擋掉 */ }
  const hostOk = PUSH_HOSTS.some((h) => host === h || (h.startsWith(".") && host.endsWith(h)));
  if (!endpoint.startsWith("https://") || !hostOk || !p256dh || !auth || endpoint.length > 1000) {
    throw new ApiError("這支手機的通知設定無法使用");
  }
  await db`insert into lamb.push_subs (endpoint, user_id, p256dh, auth, created_at) values (${endpoint}, ${me.id}, ${p256dh}, ${auth}, ${now()})
           on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = excluded.created_at`;
  await db`delete from lamb.push_subs where user_id = ${me.id} and endpoint not in
           (select endpoint from lamb.push_subs where user_id = ${me.id} order by created_at desc limit ${MAX_SUBS_PER_USER})`;
  return { ok: true };
}

async function actPushUnsubscribe({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  await db`delete from lamb.push_subs where endpoint = ${String(d.endpoint || "")} and user_id = ${me.id}`;
  return { ok: true };
}

async function actPushTest(c: Ctx, token: string) {
  const me = await requireUser(c.db, token);
  if (!(await c.db`select 1 from lamb.push_subs where user_id = ${me.id}`).length) throw new ApiError("這支手機還沒開啟通知");
  queuePush(c, [me.id], "🔔 測試通知", "看到這則通知，代表設定成功了！🐑", "./", "test");
  return { ok: true };
}

const LAND_ITEMS = 3;
const [LAND_VERSE_MAX, LAND_TIME_MAX, LAND_EVENT_MAX, LAND_RESULT_MAX] = [300, 10, 100, 200];
const LAND_PAGE = 20;

function parseItems(s: string) {
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

function landView(row: Row | null) {
  const items = (row ? parseItems(row.items) : []).filter(isObj).slice(0, LAND_ITEMS)
    .map((i: Row) => ({ time: String(i.time ?? ""), event: String(i.event ?? ""), result: String(i.result ?? "") }));
  while (items.length < LAND_ITEMS) items.push({ time: "", event: "", result: "" });
  return { day: row ? row.day : today(), verse: row ? row.verse : "", items, plant: row?.plant ?? null };
}

const landFilled = (v: ReturnType<typeof landView>) =>
  !!(v.verse.trim() || v.items.some((i) => Object.values(i).some((x) => x.trim())));

// 我的美地：今天這一頁，加上之前的頁面（新的在前，一次 20 天；before 用來載入更早的）
async function actLand({ db }: Ctx, token: string, d: Row) {
  const me = await requireUser(db, token);
  const day = today();
  const row = (await db`select d.*, p.plant from lamb.land_days d left join lamb.user_plants p on p.user_id = d.user_id and p.day = d.day
                        where d.user_id = ${me.id} and d.day = ${day}`)[0] ?? null;
  const before = typeof d.before === "string" ? d.before : day;
  const rows = await db`select d.*, p.plant from lamb.land_days d left join lamb.user_plants p on p.user_id = d.user_id and p.day = d.day
                        where d.user_id = ${me.id} and d.day < ${before} and d.day < ${day} order by d.day desc limit ${LAND_PAGE + 1}`;
  const history = rows.slice(0, LAND_PAGE).map(landView).filter(landFilled);
  return {
    today: day, entry: landView(row), history, more: rows.length > LAND_PAGE,
    oldest: rows.length ? rows[Math.min(rows.length, LAND_PAGE) - 1].day : null,
  };
}

// 只能改今天這一頁；過了午夜，手機上還開著昨天的頁面時，請它先重新載入
async function actLandSave(c: Ctx, token: string, d: Row) {
  const db = c.db;
  const me = await requireUser(db, token);
  const day = today();
  if (d.day !== day) throw new ApiError("已經是新的一天了，頁面會重新整理", 409);
  const verse = String(d.verse || "").trim();
  if (verse.length > LAND_VERSE_MAX) throw new ApiError(`經節或綱目最多 ${LAND_VERSE_MAX} 個字`);
  const raw = d.items;
  if (!Array.isArray(raw) || raw.length > LAND_ITEMS) throw new ApiError("資料格式錯誤");
  const items = raw.map((x) => {
    const i = isObj(x) ? x : {};
    const item = { time: String(i.time || "").trim(), event: String(i.event || "").trim(), result: String(i.result || "").trim() };
    if (item.time.length > LAND_TIME_MAX || item.event.length > LAND_EVENT_MAX || item.result.length > LAND_RESULT_MAX) {
      throw new ApiError(`事件最多 ${LAND_EVENT_MAX} 個字，結果最多 ${LAND_RESULT_MAX} 個字`);
    }
    return item;
  });
  await db`insert into lamb.land_days (user_id, day, verse, items, updated_at) values (${me.id}, ${day}, ${verse}, ${JSON.stringify(items)}, ${now()})
           on conflict (user_id, day) do update set verse = excluded.verse, items = excluded.items, updated_at = excluded.updated_at`;
  const result: Row = { saved: now(), plant: null, newPlant: false };
  const have = (await db`select plant from lamb.user_plants where user_id = ${me.id} and day = ${day}`)[0];
  const complete = verse && items.length === LAND_ITEMS && items.every((i) => i.time && i.event && i.result);
  if (have) result.plant = have.plant;
  else if (complete) {
    const owned = new Set(me.team_id
      ? (await db`select distinct p.plant from lamb.user_plants p join lamb.users u on u.id = p.user_id
                  where u.team_id = ${me.team_id} and p.day >= ${weekStart()}`).map((r: Row) => r.plant)
      : []);
    const keys = PLANTS.map(([k]) => k);
    const pool = keys.filter((k) => !owned.has(k));
    const plant = choice(pool.length ? pool : keys);
    await db`insert into lamb.user_plants (user_id, day, plant, created_at) values (${me.id}, ${day}, ${plant}, ${now()})`;
    Object.assign(result, { plant, newPlant: true });
    if (me.team_id) {
      queuePush(c, await teammates(db, me.team_id, me.id), "🌱 美地長出新植物", `${me.name} 填滿了今天的美地，種下一株${PLANT_NAME[plant]}`, "./", "plant");
    }
  }
  return result;
}

async function actHome({ db }: Ctx, token: string) {
  await requireUser(db, token);
  const ids = (await db`select id from lamb.teams order by score desc, id asc`).map((r: Row) => r.id);
  return { teams: await Promise.all(ids.map((i: number) => teamPayload(db, i))) };
}

// 動作名稱 → [函式, 是否會寫入資料]
type Act = (c: Ctx, token: string, d: Row) => Promise<unknown>;
const ACTIONS: Record<string, [Act, boolean]> = {
  me: [actMe, false], home: [actHome, false], enter: [actEnter, true], logout: [actLogout, true],
  invite: [actInvite, true], respondInvite: [actRespondInvite, true], cancelInvite: [actCancelInvite, true],
  dismissInvite: [actDismissInvite, true], updateTeam: [actUpdateTeam, true], checkin: [actCheckin, true],
  uncheckin: [actUncheckin, true], chatList: [actChatList, false], chatSend: [actChatSend, true],
  chatUnread: [actChatUnread, false], chatRead: [actChatRead, true], missionState: [actMissionState, false],
  missionDone: [actMissionDone, true], spin: [actSpin, true], pushKey: [actPushKey, false],
  pushSubscribe: [actPushSubscribe, true], pushUnsubscribe: [actPushUnsubscribe, true], pushTest: [actPushTest, true],
  land: [actLand, false], landSave: [actLandSave, true],
};

// 通知等回應送出後再在背景送，不讓使用者等
// deno-lint-ignore no-explicit-any
const background = (p: Promise<unknown>) => (globalThis as any).EdgeRuntime?.waitUntil ? (globalThis as any).EdgeRuntime.waitUntil(p) : p;

async function runAction(action: unknown, token: string, data: unknown) {
  if (typeof action !== "string" || !Object.hasOwn(ACTIONS, action)) throw new ApiError("找不到這個功能", 404);
  if (!isObj(data)) throw new ApiError("資料格式錯誤");
  const [fn, writes] = ACTIONS[action];
  const box: Ctx["push"] = [];
  const result = writes
    // 寫入時全部排隊（跟 SQLite 的 BEGIN IMMEDIATE 一樣），避免兩個人同時改到同一筆
    ? await sql.begin(async (tx: Db) => { await tx`select pg_advisory_xact_lock(7319)`; return fn({ db: tx, push: box }, token, data); })
    : await fn({ db: sql, push: box }, token, data);
  if (box.length) background(flushPush(box)); // 資料存好了才送通知
  return result;
}

// ---------------------------------------------------------------- 管理後台（網頁是 admin.html）
const ADMIN_PASSWORD = Deno.env.get("LAMB_ADMIN_PASSWORD") ?? "";
const LOCK_MINUTES = 15;

async function hmacHex(key: string, msg: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(msg)))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sameText(a: string, b: string) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const adminToken = () => hmacHex(ADMIN_PASSWORD, "lamb-admin");

async function requireAdmin(d: Row) {
  if (!ADMIN_PASSWORD) throw new ApiError("後台尚未開放：還沒有設定管理密碼 LAMB_ADMIN_PASSWORD", 401);
  if (!sameText(String(d.adminToken || ""), await adminToken())) throw new ApiError("請重新登入後台", 401);
}

// 防止有人一直猜密碼：同一個 IP 錯 5 次、或全部加起來錯 20 次，就鎖 15 分鐘
async function adminLogin(d: Row, ip: string) {
  if (!ADMIN_PASSWORD) throw new ApiError("後台尚未開放：還沒有設定管理密碼 LAMB_ADMIN_PASSWORD", 401);
  const [f] = await sql`select count(*) filter (where ip = ${ip})::int as mine, count(*)::int as total from lamb.admin_fails
                        where at > now() - make_interval(mins => ${LOCK_MINUTES})`;
  if (f.mine >= 5 || f.total >= 20) throw new ApiError("嘗試太多次，請 15 分鐘後再試");
  if (!sameText(String(d.password || ""), ADMIN_PASSWORD)) {
    await sql`insert into lamb.admin_fails (ip) values (${ip})`;
    await sql`delete from lamb.admin_fails where at < now() - interval '1 day'`;
    throw new ApiError("密碼錯誤");
  }
  return { adminToken: await adminToken() };
}

async function adminData() {
  const teams = await sql`select t.*, (select string_agg(name, '、' order by id) from lamb.users where team_id = t.id) as members,
                                 (select count(*)::int from lamb.users where team_id = t.id) as n
                          from lamb.teams t order by t.score desc, t.id`;
  const prizes = await sql`select team_id, prize from lamb.team_prizes`;
  const users = await sql`select u.name, u.phone, u.created_at, t.name as team from lamb.users u left join lamb.teams t on t.id = u.team_id
                          order by (u.team_id is not null), u.id`;
  const invites = await sql`select i.id, i.team_name, i.created_at, u.name as inviter,
                                   (select string_agg(mu.name || case when m.accepted = 1 then ' ✓' else ' …' end, '、' order by m.pos)
                                    from lamb.invite_members m join lamb.users mu on mu.id = m.user_id where m.invite_id = i.id) as members
                            from lamb.invites i join lamb.users u on u.id = i.inviter_id where i.status = 'pending' order by i.id`;
  const checkins = await sql`select c.created_at, c.activity, c.points, u.name as user, t.name as team from lamb.checkins c
                             join lamb.users u on u.id = c.user_id join lamb.teams t on t.id = c.team_id order by c.id desc`;
  const pushUsers = (await sql`select count(distinct user_id)::int as n from lamb.push_subs`)[0].n;
  const m = await activeMission(sql);
  let mission = null;
  if (m) {
    const rows = await sql`select t.name as team, string_agg(u.name || case when d.user_id is not null then ' ✓' else ' …' end, '、' order by u.id) as members,
                                  count(d.user_id)::int as done, count(u.id)::int as n,
                                  exists (select 1 from lamb.tickets k where k.team_id = t.id and k.mission_id = ${m.id}) as ticket
                           from lamb.teams t join lamb.users u on u.team_id = t.id
                           left join lamb.mission_done d on d.user_id = u.id and d.mission_id = ${m.id}
                           group by t.id order by t.id`;
    mission = { title: m.title, endsAt: m.ends_at, teams: [...rows] };
  }
  const armor: Record<number, string[]> = {};
  for (const p of prizes) (armor[p.team_id] ??= []).push(p.prize);
  return {
    now: now(), activities: ACTIVITIES, stages: STAGES, mission, pushUsers,
    teams: teams.map((t: Row) => ({ ...t, stage: stageOf(t.score), armor: PRIZES.filter(([k]) => armor[t.id]?.includes(k)).map(([, n]) => n) })),
    users: [...users], invites: [...invites], checkins: [...checkins],
  };
}

// 發佈新任務（正在進行的會自動結束）或提早結束
async function adminMission(d: Row, end: boolean) {
  let notify: [string, number] | null = null;
  await sql.begin(async (tx: Db) => {
    await tx`select pg_advisory_xact_lock(7319)`;
    await tx`update lamb.missions set status = 'ended' where status = 'active'`;
    const title = String(d.title || "").trim().slice(0, 40);
    if (!end && title) {
      const hours = Math.min(168, Math.max(1, parseInt(String(d.hours)) || 24));
      const ends = tw(Date.now() + hours * 3600e3).toISOString().slice(0, 19);
      await tx`insert into lamb.missions (title, created_at, ends_at) values (${title}, ${now()}, ${ends})`;
      notify = [title, hours];
    }
  });
  if (notify) {
    const [title, hours] = notify;
    const ids = (await sql`select distinct user_id from lamb.push_subs`).map((r: Row) => r.user_id);
    const span = hours < 24 ? `${hours} 小時` : `${Math.floor(hours / 24)} 天`;
    background(sendPush(ids, { title: "🎯 新的限時任務！", body: `「${title}」${span}內全組完成就能抽裝備！`, url: "./#mission", tag: "mission" }));
  }
  return adminData();
}

async function runAdmin(action: string, d: Row, ip: string) {
  if (action === "adminLogin") return adminLogin(d, ip);
  await requireAdmin(d);
  if (action === "adminData") return adminData();
  if (action === "adminMission") return adminMission(d, false);
  if (action === "adminEndMission") return adminMission(d, true);
  throw new ApiError("找不到這個功能", 404);
}

// ---------------------------------------------------------------- 排程（pg_cron 呼叫，密碼存在 lamb.config 的 cron_key）
const LAND_PING_WINDOW = 30; // 分鐘：錯過太久的提醒就不補送

// 我的美地：到了事件填的時間，提醒那個人（每件事只提醒一次）
async function sendLandReminders() {
  const t = tw();
  const day = t.toISOString().slice(0, 10), hm = t.toISOString().slice(11, 16);
  const earliest = t.getUTCHours() || t.getUTCMinutes() >= LAND_PING_WINDOW ? tw(Date.now() - LAND_PING_WINDOW * 60e3).toISOString().slice(11, 16) : "00:00";
  let count = 0, sent = 0;
  const rows = await sql`select d.user_id, d.items, u.name from lamb.land_days d join lamb.users u on u.id = d.user_id
                         where d.day = ${day} and exists (select 1 from lamb.push_subs s where s.user_id = d.user_id)`;
  for (const r of rows) {
    const items = parseItems(r.items).slice(0, LAND_ITEMS);
    for (let idx = 0; idx < items.length; idx++) {
      const it = isObj(items[idx]) ? items[idx] : {};
      const tm = String(it.time || "");
      if (!/^\d\d:\d\d$/.test(tm) || !(earliest <= tm && tm <= hm)) continue;
      const fresh = await sql`insert into lamb.land_pings (user_id, day, idx) values (${r.user_id}, ${day}, ${idx}) on conflict do nothing returning idx`;
      if (!fresh.length) continue;
      count++;
      const event = String(it.event || "").trim() || `你安排的第${idx + 1}件事`;
      sent += await sendPush([r.user_id], { title: `⏰ ${tm} 到了`, body: `${r.name}：${event}`, url: "./#land", tag: `land-${idx}` });
    }
  }
  return { count, sent };
}

// 每天提醒：今天還沒記錄任何項目、而且有開通知的人
async function sendDailyReminder() {
  const users = await sql`select distinct u.id, u.name from lamb.users u join lamb.push_subs p on p.user_id = u.id
                          where u.team_id is not null and not exists (select 1 from lamb.checkins c where c.user_id = u.id and c.day = ${today()})`;
  let sent = 0;
  for (const u of users) {
    sent += await sendPush([u.id], { title: "⏰ 今天記錄了嗎？", body: `${u.name}，讀經、禱告、呼求主名…做到了就來按一下，讓小羊長大 🐑`, url: "./", tag: "remind" });
  }
  return { count: users.length, sent };
}

async function runCron(job: unknown, key: string) {
  const real = (await sql`select value from lamb.config where key = 'cron_key'`)[0]?.value ?? "";
  if (!real || !sameText(key, real)) throw new ApiError("forbidden", 403);
  if (job === "land") return sendLandReminders();
  if (job === "remind") return sendDailyReminder();
  throw new ApiError("找不到這個排程", 404);
}

// ---------------------------------------------------------------- HTTP
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { ...CORS, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "POST") throw new ApiError("找不到這個功能", 404);
    const text = await req.text();
    if (text.length > MAX_BODY) throw new ApiError("資料太大", 413);
    let body: unknown;
    try { body = JSON.parse(text || "{}"); } catch { throw new ApiError("資料格式錯誤"); }
    if (!isObj(body)) throw new ApiError("資料格式錯誤");
    if (body.cron) return json(await runCron(body.cron, String(body.key || "")));
    const data = body.data || {};
    if (typeof body.action === "string" && body.action.startsWith("admin")) {
      if (!isObj(data)) throw new ApiError("資料格式錯誤");
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim();
      return json(await runAdmin(body.action, data, ip));
    }
    return json(await runAction(body.action, String(body.token || ""), data));
  } catch (e) {
    if (e instanceof ApiError) return json({ error: e.message }, e.status);
    console.error("ERROR", e);
    return json({ error: "伺服器錯誤" }, 500);
  }
});
