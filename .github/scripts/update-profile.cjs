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
 * 环境变量：
 *   OWNER：个人账号名，工作流默认传入当前主页仓库所有者。
 *   ORG：需要合并统计的组织账号名；未设置时使用 xxdlovo。
 *   GITHUB_TOKEN：可选，配上能提高接口限额。
 */

const fs = require('fs')
const path = require('path')

const OWNER = process.env.OWNER || process.argv[2]
// 组织是公开数据的第二个来源。保留环境变量入口，便于以后迁移组织时不用改脚本逻辑。
const ORG = process.env.ORG || 'xxdlovo'
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

/**
 * 读取一个仓库列表接口的所有页面。
 *
 * GitHub 每页最多返回 100 项，个人或组织仓库超过这个数量时，直接读取首页会悄悄漏算。
 * 这里依据本页数量判断是否还有下一页，因此个人与组织两种仓库接口都能复用此函数。
 */
async function getAllRepos(pathname) {
  const repos = []
  for (let page = 1; ; page += 1) {
    const joiner = pathname.includes('?') ? '&' : '?'
    const batch = await gh(`${pathname}${joiner}per_page=100&page=${page}`)
    repos.push(...batch)
    if (batch.length < 100) return repos
  }
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

/**
 * 将个人和组织仓库汇总为一份可统计的数据集。
 *
 * 主页仓库本身会因自动更新而持续产生提交，不能作为“最近项目”参与排序；Fork 也不代表
 * 当前账号或组织的原创代码。两类仓库均在这里过滤，并用 full_name 去重，保证后续的
 * Star、语言和项目列表始终使用同一口径的数据。
 */
function mergeRepos(personalRepos, orgRepos) {
  const unique = new Map()
  for (const repo of [...personalRepos, ...orgRepos]) {
    const isProfileRepo =
      repo.owner.login.toLowerCase() === OWNER.toLowerCase() &&
      repo.name.toLowerCase() === OWNER.toLowerCase()
    if (!repo.fork && !isProfileRepo) unique.set(repo.full_name, repo)
  }
  return [...unique.values()].sort((a, b) => new Date(b.pushed_at) - new Date(a.pushed_at))
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

function buildStackSvg(langs, totalBytes) {
  const rows = langs.slice(0, MAX_LANGS)
  const W = 680
  const padX = 32
  const rowH = 48
  // 副标题已从图片中移除，首行上移以避免标题与图表之间留下无意义的空白。
  const startY = 82
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
  .ln{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:14px;font-weight:700;fill:#4A586C}
  .lp{font-family:system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;font-size:12.5px;font-weight:600;fill:#93A0B4;text-anchor:end}
  .track{fill:#E0E7F1;filter:url(#inset)}
  .fill{filter:url(#softS)}
  @media (prefers-color-scheme:dark){
    .panel{fill:#161B22}
    .card{fill:#171D27;filter:url(#softD)}
    .title{fill:#E6EDF3}
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
  ${bars}
</svg>
`
}

/* ---------------------------------- 主流程 ---------------------------------- */

async function main() {
  console.log(`开始抓取 ${OWNER} 与 ${ORG} 的公开数据…`)

  const user = await gh(`/users/${OWNER}`)
  const [personalRepos, orgRepos] = await Promise.all([
    // 个人端只取账号真正拥有的公开仓库，协作仓库不计入个人公开仓库统计。
    getAllRepos(`/users/${OWNER}/repos?sort=pushed&type=owner`),
    // 组织端明确限制为公开仓库，避免令牌权限变化导致私有项目名称写入公开主页。
    getAllRepos(`/orgs/${ORG}/repos?sort=pushed&type=public`),
  ])
  const repos = mergeRepos(personalRepos, orgRepos)

  const stars = repos.reduce((sum, r) => sum + r.stargazers_count, 0)
  const days = Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86400000)

  // 语言分布只抽样最近活跃的仓库，以控制 Actions 的接口请求数量，同时保持结果有时效性。
  const sample = repos.slice(0, MAX_LANG_REPOS)
  const byteMap = {}
  for (const r of sample) {
    if (!r.language && r.size === 0) continue
    try {
      const langs = await gh(`/repos/${r.full_name}/languages`)
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
    `  仓库 ${repos.length}（个人 ${personalRepos.length} / 组织 ${orgRepos.length}） · star ${stars} · 语言 ${langList.length} 种`
  )

  const stamp = beijingStamp()

  /* --- 区块一：概览数字（仓库、Star 和语言均按个人 + 组织汇总） --- */
  const statsBody = [
    { v: compact(repos.length), l: '开源仓库' },
    { v: compact(stars), l: '累计 Star' },
    // 关注者和账号创建日期是个人账号属性，不能把组织成员或组织创建时间混为同一个指标。
    { v: compact(user.followers), l: '个人关注者' },
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

  /* --- 区块二：个人与组织合并后，按最近推送时间排列的项目列表 --- */
  const recentRows = repos.slice(0, 4).map((r) => {
    const pushed = new Date(r.pushed_at)
    const date = `${pushed.getUTCFullYear()}-${pad(pushed.getUTCMonth() + 1)}-${pad(
      pushed.getUTCDate()
    )}`
    return `| [${esc(r.name)}](https://github.com/${r.full_name}) | ${esc(r.language) ||
      '—'} | ${date} |`
  })
  const recentBody = [
    '| 项目 | 语言 | 更新日期 |',
    '| --- | --- | --- |',
    ...(recentRows.length ? recentRows : ['| 还没有公开项目 | — | — |']),
  ].join('\n')

  /* --- 写入 --- */
  const readmePath = path.join(ROOT, 'README.md')
  const svgPath = path.join(ROOT, 'assets', 'stack.svg')
  let md = fs.readFileSync(readmePath, 'utf8')
  md = replaceBlock(md, 'STATS', statsBody)
  md = replaceBlock(md, 'RECENT', recentBody)
  md = replaceBlock(md, 'UPDATED', `<sub>更新于 ${stamp}（北京时间）</sub>`)

  const svg = buildStackSvg(langList, totalBytes)

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
