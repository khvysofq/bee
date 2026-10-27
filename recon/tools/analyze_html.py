#!/usr/bin/env python3
"""勘查辅助：解析本地保存的 fengj 页面样本（只读本地文件，不发请求）。

用法: python3 -I analyze_html.py <file> [--links] [--rows] [--dates] [--js]
"""
import glob
import html as htmlmod
import os
import re
import sys


def load(path: str) -> str:
    # 支持传入 glob 片段路径（沙箱显示层会把日期目录渲染错，glob 最稳）
    if any(c in path for c in "*?["):
        matches = glob.glob(path)
        if not matches:
            sys.exit(f"no match for {path}")
        path = matches[0]
    elif os.path.isdir(path):
        # 传入目录 + 在 flags 里给 --pick <name-substring>
        pass
    data = open(path, "rb").read()
    for enc in ("utf-8", "gb18030"):
        try:
            return data.decode(enc), path, len(data), enc
        except UnicodeDecodeError:
            continue
    return data.decode("utf-8", "replace"), path, len(data), "utf-8(replace)"


def main() -> None:
    f, *flags = sys.argv[1:]
    if os.path.isdir(f):
        pick = flags[flags.index("--pick") + 1] if "--pick" in flags else ""
        hits = sorted(
            os.path.join(dp, fn)
            for dp, _, fns in os.walk(f)
            for fn in fns
            if fn.startswith(pick)
        )
        if not hits:
            sys.exit(f"no file starting with {pick!r} under {f}")
        f = hits[0]
    text, path, size, enc = load(f)
    print(f"FILE {path} size={size} enc={enc}")

    if "--links" in flags:
        seen = set()
        for m in re.finditer(r"""href=['"]([^'"]+)['"][^>]*>([^<]{0,40})""", text):
            href, label = m.group(1), htmlmod.unescape(m.group(2)).strip()
            key = (href, label)
            if key in seen:
                continue
            seen.add(key)
            low = href.lower() + label
            if re.search(r"(走势|历史|行情|回顾|月报|周报|更多|list|graph|his|zoushi|zhishi|price|/p\d+|\d{4})", low):
                print(f"  {href}  |  {label}")

    if "--dates" in flags:
        ds = sorted(set(re.findall(r"20\d{2}[-/年]\d{1,2}[-/月]\d{1,2}", text)))
        print("DATES:", ds[:5], "...", ds[-5:] if len(ds) > 5 else "", f"(n={len(ds)})")

    if "--rows" in flags:
        n_li = len(re.findall(r'<li[^>]*>\s*(?:<span>)', text))
        for cls in ("roll_list", "roll_list_name"):
            print(f"CLASS {cls}: {len(re.findall('class=\"[^\"]*' + cls, text))}")
        spans = re.findall(r"<li[^>]*>(.*?)</li>", text, re.S)
        rows = 0
        for s in spans:
            if len(re.findall(r"<span", s)) >= 6:
                rows += 1
        print(f"ROW-LIKE li (>=6 spans): {rows}")
        # 省份覆盖
        provs = set(re.findall(r"<span[^>]*>\s*([一-龥]{2,3}(?:省|市|区))\s*<", text))
        print(f"PROVINCE-LIKE spans: {len(provs)}", sorted(provs)[:12])

    if "--js" in flags:
        for kw in ("echarts", "ECharts", "highcharts", "ajax", "$.get", "$.post", "url:", "setInterval", "json"):
            c = text.count(kw)
            if c:
                print(f"JS {kw}: {c}")
        for m in re.finditer(r"""url\s*[:=]\s*['"]([^'"]+)['"]""", text):
            print("  AJAX URL:", m.group(1))
        for m in re.finditer(r"""src=['"]([^'"]*\.js[^'"]*)['"]""", text):
            print("  SCRIPT:", m.group(1))


if __name__ == "__main__":
    main()
