// Свой keccak против эталонов. Если он врёт — проверка PoolId бессмысленна,
// а это единственная защита от работы не с тем пулом.
const { keccak256 } = require('../src/keccak.js');
const V = [
  ['', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
  ['abc', '0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45'],
  ['The quick brown fox jumps over the lazy dog',
   '0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15'],
  ['0x', '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470'],
];
let bad = 0;
for (const [inp, want] of V) {
  const got = keccak256(inp);
  const okk = got === want;
  if (!okk) bad++;
  console.log(`  ${okk ? 'ок' : 'ПРОВАЛ'}: "${inp.slice(0, 30)}" → ${got.slice(0, 20)}…`);
}
// Селекторы, которые мы уже проверили другим способом — сходятся ли
const sel = (s) => keccak256(s).slice(0, 10);
const SELS = {
  'modifyLiquidities(bytes,uint256)': '0xdd46508f',
  'poolKeys(bytes25)': '0x86b6be7d',
  'getSlot0(bytes32)': '0xc815641c',
  'approve(address,address,uint160,uint48)': '0x87517c45',
};
for (const [sig, want] of Object.entries(SELS)) {
  const got = sel(sig);
  const okk = got === want;
  if (!okk) bad++;
  console.log(`  ${okk ? 'ок' : 'ПРОВАЛ'}: селектор ${sig.split('(')[0]} → ${got}`);
}
// И главное: пересчёт PoolId настоящего пула автора
const KEY =
  '0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168' +
  '000000000000000000000000ad6629157a774007e46945bb1b6013c79e7656c9' +
  '000000000000000000000000000000000000000000000000000000000000c350' +
  '00000000000000000000000000000000000000000000000000000000000001f4' +
  '0000000000000000000000000000000000000000000000000000000000000000';
const WANT = '0xa6ef908585525ed3df7eea8735744af0586a14d1f7dd0378adf84b5b076ea9ba';
const got = keccak256('0x' + KEY);
(got === WANT) ? console.log('  ок: PoolId настоящего пула пересчитан верно')
               : (console.log(`  ПРОВАЛ: PoolId ${got}`), bad++);
console.log('\nитог: ' + (bad ? `ПРОВАЛОВ ${bad}` : 'keccak верен'));
process.exitCode = bad ? 1 : 0;
