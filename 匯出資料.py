#!/usr/bin/env python3
"""把 PythonAnywhere 版的 data.db 轉成 Supabase 用的 SQL（只用 Python 標準函式庫）

用法：python3 匯出資料.py data.db > 匯入.sql
然後把 匯入.sql 的內容貼到 Supabase 的 SQL Editor 執行（會先清空 lamb 裡的舊資料）。
登入紀錄和通知設定不搬：網址換了，大家要重新登入、重新開啟通知。
"""
import sqlite3
import sys

# 依照外鍵順序
TABLES = ["teams", "users", "checkins", "invites", "invite_members", "messages", "missions", "mission_done",
          "tickets", "team_prizes", "land_days", "user_plants", "land_pings", "chat_reads"]
IDENTITY = ["teams", "users", "checkins", "invites", "messages", "missions", "tickets"]


def lit(v):
    if v is None:
        return "null"
    if isinstance(v, int):
        return str(v)
    return "'" + str(v).replace("'", "''") + "'"


def main(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    have = {r[0] for r in conn.execute("select name from sqlite_master where type = 'table'")}
    out = ["begin;", "truncate %s restart identity cascade;" % ", ".join("lamb." + t for t in TABLES + ["sessions", "push_subs"])]
    for t in TABLES:
        if t not in have:
            continue
        rows = conn.execute("select * from %s" % t).fetchall()
        for r in rows:
            out.append("insert into lamb.%s (%s) values (%s);" % (t, ", ".join(r.keys()), ", ".join(lit(r[k]) for k in r.keys())))
        print("-- %s: %d 筆" % (t, len(rows)), file=sys.stderr)
    for t in IDENTITY:  # 讓之後新增的資料編號接在後面
        out.append("select setval(pg_get_serial_sequence('lamb.%s', 'id'), coalesce((select max(id) from lamb.%s), 0) + 1, false);" % (t, t))
    out.append("commit;")
    print("\n".join(out))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("用法：python3 匯出資料.py data.db > 匯入.sql")
    main(sys.argv[1])
