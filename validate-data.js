const fs = require('fs');
const vm = require('vm');

const html = fs.readFileSync('index.html', 'utf8');
const script = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].at(-1)[1];
const makeEl = () => ({ innerHTML:'', textContent:'', value:'', dataset:{}, className:'', disabled:false, files:[], classList:{toggle(){}}, addEventListener(){}, focus(){}, select(){}, click(){} });
const elements = new Map();
const context = {
  console,
  URLSearchParams,
  Blob,
  URL: { createObjectURL(){ return 'blob:test'; }, revokeObjectURL(){} },
  localStorage: { getItem(){ return null; }, setItem(){} },
  sessionStorage: { getItem(){ return null; }, setItem(){}, removeItem(){} },
  crypto: { getRandomValues(a){ a[0] = 1; return a; } },
  window: { location: { search:'', origin:'http://localhost', pathname:'/', hash:'' }, crypto:null, scrollTo(){} },
  history: { replaceState(){} },
  document: { body:{ dataset:{} }, querySelectorAll(){ return []; }, getElementById(id){ if(!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); }, createElement(){ return makeEl(); }, execCommand(){} },
  navigator: { clipboard: { writeText: async () => {} } },
  fetch: async () => ({ ok:true, json:async()=>({ state:null }) }),
  setInterval(){},
  Intl,
  btoa:v=>Buffer.from(v,'binary').toString('base64'),
  atob:v=>Buffer.from(v,'base64').toString('binary'),
  unescape,
  escape,
  encodeURIComponent,
  decodeURIComponent,
  Math,
  Number,
  String,
  Object,
  Array,
  JSON,
  RegExp,
  parseInt,
  Date,
  Set,
  Map
};
context.window.crypto = context.crypto;
vm.createContext(context);
vm.runInContext(script, context);

const report = vm.runInContext(`(() => {
  const errors = [];
  const uniqueTeams = new Set(TEAMS.map(t => t.name));
  const groupCounts = Object.fromEntries(GROUP_NAMES.map(g => [g, TEAMS.filter(t => t.group === g).length]));
  const allMatches = [...GROUP_MATCHES, ...KNOCKOUT_MATCHES];
  const nums = allMatches.map(m => m.matchNo);
  const groupApps = Object.fromEntries(TEAMS.map(t => [t.name, 0]));

  if (TEAMS.length !== 48) errors.push('Expected 48 teams, found ' + TEAMS.length);
  if (uniqueTeams.size !== 48) errors.push('Expected 48 unique teams, found ' + uniqueTeams.size);
  if (GROUP_NAMES.length !== 12) errors.push('Expected 12 groups, found ' + GROUP_NAMES.length);
  for (const [group, count] of Object.entries(groupCounts)) if (count !== 4) errors.push('Group ' + group + ' has ' + count + ' teams');
  if (GROUP_MATCHES.length !== 72) errors.push('Expected 72 group-stage matches, found ' + GROUP_MATCHES.length);
  if (allMatches.length !== 104) errors.push('Expected 104 matches, found ' + allMatches.length);
  if (new Set(nums).size !== nums.length) errors.push('Duplicate match numbers detected');

  for (const match of GROUP_MATCHES) {
    if (!(match.homeTeam in groupApps)) errors.push('Unknown home team in match ' + match.matchNo + ': ' + match.homeTeam);
    if (!(match.awayTeam in groupApps)) errors.push('Unknown away team in match ' + match.matchNo + ': ' + match.awayTeam);
    groupApps[match.homeTeam] += 1;
    groupApps[match.awayTeam] += 1;
  }
  for (const [team, apps] of Object.entries(groupApps)) if (apps !== 3) errors.push(team + ' plays ' + apps + ' group matches');

  for (const match of KNOCKOUT_MATCHES) {
    for (const slot of [match.home, match.away]) {
      if ((slot.type === 'winner' || slot.type === 'loser') && !nums.includes(slot.matchNo)) errors.push('Match ' + match.matchNo + ' references missing match ' + slot.matchNo);
      if ((slot.type === 'winner' || slot.type === 'loser') && slot.matchNo >= match.matchNo) errors.push('Match ' + match.matchNo + ' references non-earlier match ' + slot.matchNo);
    }
  }

  return JSON.stringify({
    pass: errors.length === 0,
    errors,
    summary: {
      teams: TEAMS.length,
      uniqueTeams: uniqueTeams.size,
      groups: Object.keys(groupCounts).length,
      groupMatches: GROUP_MATCHES.length,
      totalMatches: allMatches.length,
      duplicateMatchNumbers: nums.length - new Set(nums).size
    },
    firstMatch: GROUP_MATCHES[0],
    finalMatch: KNOCKOUT_MATCHES.find(m => m.matchNo === 104)
  });
})()`, context);

console.log(JSON.stringify(JSON.parse(report), null, 2));
