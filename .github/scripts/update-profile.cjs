#!/usr/bin/env node
/**
 * 生成 README.md 里的动态数据区块
 *
 * GitHub 的 README 不支持运行时脚本，所以"动态"靠两件事：
 *   1. 本脚本由 GitHub Actions 定时执行，把抓到的真实数据写回 README 的标记区块
 *   2. 图片类的内容（贪吃蛇图、技术栈图）写成 SVG 文件，README 引用后每次打开都会重新拉取
 *
 * 用法：
 *   node .github/scripts/update-profile.cjs <用户名> [--dry]
 * 环境变量：GITHUB_TOKEN（可选，配上能提高接口限额）
 */

const fs = require('fs')
const path = require('path')

const OWNER = process.env.OWNER || process.argv[2]
const TOKEN = process.env.GITHUB_TOKEN
const DRY = process.argv.includes('--dry')
const ROOT = path.resolve(__dirname, '..', '..')

const MAX_LANG_REPOS = 25 // 统计语言时最多拉取的仓库数，省接口额度
const MAX_LANGS = 6 // 技术栈图最多画几种语言

if (!OWNER) {
  console.error('缺少用户名：node update-profile.cjs <username>')
  process.exit(1)
}

/* ---------------------------------- 请求 ---------------------------------- */

async function gh(pathname) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'profile-readme-updater',
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  })
  if (!res.ok) throw new Error(`接口 ${res.status}：${pathname}`)
  return res.json()
}

/* --------------------------------- 工具函数 -------------------------------- */

const esc = (s) => String(s ?? '').replace(/[|\r\n]/g, ' ').trim()
const escXml = (s) =>
  String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const pad = (n) => String(n).padStart(2, '0')

function beijingStamp() {
  const d = new Date(Date.now() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(
    d.getUTCHours()
  )}:${pad(d.getUTCMinutes())}`
}

function compact(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(n)
}

function replaceBlock(md, key, body) {
  const re = new RegExp(`<!-- ${key}:START -->[\\s\\S]*?<!-- ${key}:END -->`)
  if (!re.test(md)) throw new Error(`README 里找不到 ${key} 标记，区块无法更新`)
  return md.replace(re, `<!-- ${key}:START -->\n${body}\n<!-- ${key}:END -->`)
}

/* -------------------------------- 语言颜色表 ------------------------------- */

const LANG_COLORS = {
  TypeScript: '#3178C6',
  JavaScript: '#F1E05A',
  Vue: '#41B883',
  CSS: '#663399',
  SCSS: '#C6538C',
  HTML: '#E34C26',
  Python: '#3572A5',
  Java: '#B07219',
  Kotlin: '#A97BFF',
  Swift: '#F05138',
  Go: '#00ADD8',
  Rust: '#DEA584',
  'C++': '#F34B7D',
  C: '#555555',
  'C#': '#178600',
  PHP: '#4F5D95',
  Ruby: '#701516',
  Dart: '#00B4AB',
  Shell: '#89E051',
  Dockerfile: '#384D54',
  Lua: '#000080',
  'Jupyter Notebook': '#DA5B0B',
  MDX: '#FCB32C',
  Astro: '#FF5A03',
  Svelte: '#FF3E00',
}

const colorOf = (name) => LANG_COLORS[name] || '#8B98AC'

/* ------------------------------ 技术栈 SVG 生成 ----------------------------- */

function buildStackSvg(langs, totalBytes, repoCount, stamp) {
  const rows = langs.slice(0, MAX_LANGS)
  const W = 680
  const padX = 32
  const rowH = 48
  const startY = 104
  const H = startY + rows.length * rowH + 24
  const trackW = W - padX * 2
  const max = rows.length ? rows[0].bytes : 1

  const bars = rows
    .map((l, i) => {
      const y = startY + i * rowH
      const pct = totalBytes ? l.bytes / totalBytes : 0
      const w = Math.max(10, (l.bytes / max) * trackW)
      return [
        `<text class="ln" x="${padX}" y="${y}">${escXml(l.name)}</text>`,
        `<text class="lp" x="${W - padX}" y="${y}">${(pct * 100).toFixed(1)}%</text>`,
        `<rect class="track" x="${padX}" y="${y + 12}" width="${trackW}" height="14" rx="7"/>`,
        `<rect class="fill" x="${padX}" y="${y + 12}" width="${w.toFixed(1)}" height="14" rx="7" fill="${colorOf(
          l.name
        )}"/>`,
      ].join('\n  ')
    })
    .join('\n  ')

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="常用技术栈分布">
<style>
  .panel{fill:#EDF1F7}
  .card{fill:#EDF1F7;filter:url(#softL)}
  .title{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:21px;font-weight:800;fill:#3A4759}
  .sub{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12px;fill:#93A0B4}
  .ln{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;font-weight:700;fill:#4A586C}
  .lp{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12.5px;font-weight:600;fill:#93A0B4;text-anchor:end}
  .track{fill:#E0E7F1;filter:url(#inset)}
  .fill{filter:url(#softS)}
  @media (prefers-color-scheme:dark){
    .panel{fill:#161B22}
    .card{fill:#171D27;filter:url(#softD)}
    .title{fill:#E6EDF3}
    .sub{fill:#8B98AC}
    .ln{fill:#D6E0EC}
    .lp{fill:#8B98AC}
    .track{fill:#0E131A;filter:url(#insetD)}
  }
</style>
<defs>
  <filter id="softL" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="b"/>
    <feOffset in="b" dx="7" dy="7" result="o1"/>
    <feFlood flood-color="#C3CDDD" flood-opacity="0.95" result="f1"/>
    <feComposite in="f1" in2="o1" operator="in" result="s1"/>
    <feOffset in="b" dx="-7" dy="-7" result="o2"/>
    <feFlood flood-color="#FFFFFF" flood-opacity="1" result="f2"/>
    <feComposite in="f2" in2="o2" operator="in" result="s2"/>
    <feMerge><feMergeNode in="s1"/><feMergeNode in="s2"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="softD" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="b"/>
    <feOffset in="b" dx="7" dy="7" result="o1"/>
    <feFlood flood-color="#05070B" flood-opacity="0.9" result="f1"/>
    <feComposite in="f1" in2="o1" operator="in" result="s1"/>
    <feOffset in="b" dx="-7" dy="-7" result="o2"/>
    <feFlood flood-color="#252E3B" flood-opacity="0.9" result="f2"/>
    <feComposite in="f2" in2="o2" operator="in" result="s2"/>
    <feMerge><feMergeNode in="s1"/><feMergeNode in="s2"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="softS" x="-60%" y="-60%" width="220%" height="220%">
    <feGaussianBlur in="SourceAlpha" stdDeviation="3" result="b"/>
    <feOffset in="b" dx="3" dy="3" result="o1"/>
    <feFlood flood-color="#AEBACB" flood-opacity="0.85" result="f1"/>
    <feComposite in="f1" in2="o1" operator="in" result="s1"/>
    <feOffset in="b" dx="-3" dy="-3" result="o2"/>
    <feFlood flood-color="#FFFFFF" flood-opacity="0.9" result="f2"/>
    <feComposite in="f2" in2="o2" operator="in" result="s2"/>
    <feMerge><feMergeNode in="s1"/><feMergeNode in="s2"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <filter id="inset" x="-50%" y="-50%" width="200%" height="200%">
    <feOffset dx="2" dy="2" in="SourceAlpha" result="off"/>
    <feGaussianBlur in="off" stdDeviation="2" result="blur"/>
    <feComposite operator="out" in="SourceGraphic" in2="blur" result="inv"/>
    <feFlood flood-color="#93A0B4" flood-opacity="0.55" result="c"/>
    <feComposite operator="in" in="c" in2="inv" result="sh"/>
    <feComposite operator="over" in="sh" in2="SourceGraphic"/>
  </filter>
  <filter id="insetD" x="-50%" y="-50%" width="200%" height="200%">
    <feOffset dx="2" dy="2" in="SourceAlpha" result="off"/>
    <feGaussianBlur in="off" stdDeviation="2" result="blur"/>
    <feComposite operator="out" in="SourceGraphic" in2="blur" result="inv"/>
    <feFlood flood-color="#000000" flood-opacity="0.6" result="c"/>
    <feComposite operator="in" in="c" in2="inv" result="sh"/>
    <feComposite operator="over" in="sh" in2="SourceGraphic"/>
  </filter>
</defs>

<rect class="panel" x="0" y="0" width="${W}" height="${H}" rx="30"/>
<text class="title" x="${padX}" y="52">常用技术栈</text>
<text class="sub" x="${padX}" y="76">按代码量统计 · 取样 ${repoCount} 个仓库 · 更新于 ${stamp}</text>
  ${bars}
</svg>
`
}

/* ---------------------------------- 主流程 ---------------------------------- */

async function main() {
  console.log(`开始抓取 ${OWNER} 的公开数据…`)

  const user = await gh(`/users/${OWNER}`)
  const rawRepos = await gh(`/users/${OWNER}/repos?per_page=100&sort=pushed&type=owner`)

  // 排除 fork；排除主页仓库本身，否则它会被机器人一直推到第一位
  const repos = rawRepos.filter(
    (r) => !r.fork && r.name.toLowerCase() !== OWNER.toLowerCase()
  )

  const stars = repos.reduce((sum, r) => sum + r.stargazers_count, 0)
  const days = Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000)

  // 语言分布：只对最近活跃的若干仓库取样
  const sample = repos.slice(0, MAX_LANG_REPOS)
  const byteMap = {}
  let langRepoCount = 0
  for (const r of sample) {
    if (!r.language && r.size === 0) continue
    try {
      const langs = await gh(`/repos/${r.full_name}/languages`)
      langRepoCount += 1
      for (const [name, bytes] of Object.entries(langs)) {
        byteMap[name] = (byteMap[name] || 0) + bytes
      }
    } catch (e) {
      console.warn(`  跳过 ${r.full_name} 的语言统计：${e.message}`)
    }
  }
  const langList = Object.entries(byteMap)
    .map(([name, bytes]) => ({ name, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
  const totalBytes = langList.reduce((s, l) => s + l.bytes, 0)

  console.log(
    `  仓库 ${repos.length} · star ${stars} · 关注者 ${user.followers} · 语言 ${langList.length} 种`
  )

  const stamp = beijingStamp()

  /* --- 区块一：概览数字（半透明卡片，明暗主题自适应） --- */
  const statsBody = [
    { v: compact(repos.length), l: '公开仓库' },
    { v: compact(stars), l: '收获 Star' },
    { v: compact(user.followers), l: '关注者' },
    { v: langList[0] ? langList[0].name : '—', l: '最常用语言' },
    { v: `${days}`, l: 'GitHub 天数' },
  ]
    .map(
      ({ v, l }) => `<div style="display:inline-block;min-width:112px;padding:16px 20px;margin:7px;border-radius:22px;background:rgba(140,150,170,0.14);box-shadow:7px 7px 15px rgba(20,30,50,0.10),-7px -7px 15px rgba(255,255,255,0.28);">
  <div style="font-size:26px;font-weight:800;line-height:1.2;">${escXml(v)}</div>
  <div style="margin-top:6px;font-size:11.5px;opacity:0.6;letter-spacing:2px;">${escXml(l)}</div>
</div>`
    )
    .join('\n')

  /* --- 区块二：最近在折腾的项目 --- */
  const recentRows = repos.slice(0, 4).map((r) => {
    const pushed = new Date(r.pushed_at)
    const date = `${pushed.getUTCFullYear()}-${pad(pushed.getUTCMonth() + 1)}-${pad(
      pushed.getUTCDate()
    )}`
    return `| [${esc(r.name)}](https://github.com/${r.full_name}) | ${esc(r.description) ||
      '暂无描述'} | ${esc(r.language) || '—'} | ${date} |`
  })
  const recentBody = [
    '| 项目 | 说明 | 主要语言 | 最近提交 |',
    '| --- | --- | --- | --- |',
    ...(recentRows.length ? recentRows : ['| 还没有公开项目 | — | — | — |']),
  ].join('\n')

  /* --- 写入 --- */
  const readmePath = path.join(ROOT, 'README.md')
  const svgPath = path.join(ROOT, 'assets', 'stack.svg')
  let md = fs.readFileSync(readmePath, 'utf8')
  md = replaceBlock(md, 'STATS', statsBody)
  md = replaceBlock(md, 'RECENT', recentBody)
  md = replaceBlock(md, 'UPDATED', `> 数据由 GitHub Actions 每 6 小时自动抓取更新，最近一次：${stamp}（北京时间）`)

  const svg = buildStackSvg(langList, totalBytes, langRepoCount, stamp)

  if (DRY) {
    console.log('\n===== STATS =====\n' + statsBody)
    console.log('\n===== RECENT =====\n' + recentBody)
    console.log(`\n===== SVG =====\n${svg.slice(0, 600)}…\n（共 ${svg.length} 字节）`)
    return
  }

  fs.writeFileSync(readmePath, md)
  fs.mkdirSync(path.dirname(svgPath), { recursive: true })
  fs.writeFileSync(svgPath, svg)
  console.log('已更新 README.md 与 assets/stack.svg')
}

main().catch((e) => {
  console.error('更新失败：', e.message)
  process.exit(1)
})
