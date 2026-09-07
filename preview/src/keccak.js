// keccak256 без внешних зависимостей.
//
// Нужен для одного: пересчитать PoolId из PoolKey и убедиться, что это тот
// самый пул. Тянуть библиотеку с чужого сайта в терминал, который работает с
// деньгами, нельзя — поэтому здесь своя реализация.
//
// Сверена с эталонами в tests/keccak.test.js, включая пустую строку
// (c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470).

'use strict';

(function (root) {
  const RC = [
    0x00000001, 0x00000000, 0x00008082, 0x00000000, 0x0000808a, 0x80000000,
    0x80008000, 0x80000000, 0x0000808b, 0x00000000, 0x80000001, 0x00000000,
    0x80008081, 0x80000000, 0x00008009, 0x80000000, 0x0000008a, 0x00000000,
    0x00000088, 0x00000000, 0x80008009, 0x00000000, 0x8000000a, 0x00000000,
    0x8000808b, 0x00000000, 0x0000008b, 0x80000000, 0x00008089, 0x80000000,
    0x00008003, 0x80000000, 0x00008002, 0x80000000, 0x00000080, 0x80000000,
    0x0000800a, 0x00000000, 0x8000000a, 0x80000000, 0x80008081, 0x80000000,
    0x00008080, 0x80000000, 0x80000001, 0x00000000, 0x80008008, 0x80000000,
  ];
  const R = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25,
             43, 62, 18, 39, 61, 20, 44];
  const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12,
              2, 20, 14, 22, 9, 6, 1];

  function keccakF(s) {
    for (let round = 0; round < 24; round++) {
      // θ
      const c = new Array(10);
      for (let x = 0; x < 5; x++) {
        c[x * 2] = s[x * 2] ^ s[(x + 5) * 2] ^ s[(x + 10) * 2] ^
                   s[(x + 15) * 2] ^ s[(x + 20) * 2];
        c[x * 2 + 1] = s[x * 2 + 1] ^ s[(x + 5) * 2 + 1] ^ s[(x + 10) * 2 + 1] ^
                       s[(x + 15) * 2 + 1] ^ s[(x + 20) * 2 + 1];
      }
      for (let x = 0; x < 5; x++) {
        const x1 = ((x + 1) % 5) * 2, x4 = ((x + 4) % 5) * 2;
        const dl = c[x4] ^ ((c[x1] << 1) | (c[x1 + 1] >>> 31));
        const dh = c[x4 + 1] ^ ((c[x1 + 1] << 1) | (c[x1] >>> 31));
        for (let y = 0; y < 25; y += 5) {
          s[(x + y) * 2] ^= dl;
          s[(x + y) * 2 + 1] ^= dh;
        }
      }
      // ρ и π
      let lastL = s[2], lastH = s[3];
      for (let i = 0; i < 24; i++) {
        const j = PI[i], r = R[i];
        const tl = s[j * 2], th = s[j * 2 + 1];
        if (r < 32) {
          s[j * 2] = (lastL << r) | (lastH >>> (32 - r));
          s[j * 2 + 1] = (lastH << r) | (lastL >>> (32 - r));
        } else if (r === 32) {
          s[j * 2] = lastH; s[j * 2 + 1] = lastL;
        } else {
          const rr = r - 32;
          s[j * 2] = (lastH << rr) | (lastL >>> (32 - rr));
          s[j * 2 + 1] = (lastL << rr) | (lastH >>> (32 - rr));
        }
        lastL = tl; lastH = th;
      }
      // χ
      for (let y = 0; y < 25; y += 5) {
        const t = [];
        for (let x = 0; x < 5; x++) { t[x * 2] = s[(y + x) * 2]; t[x * 2 + 1] = s[(y + x) * 2 + 1]; }
        for (let x = 0; x < 5; x++) {
          const a = ((x + 1) % 5) * 2, b = ((x + 2) % 5) * 2;
          s[(y + x) * 2] = t[x * 2] ^ (~t[a] & t[b]);
          s[(y + x) * 2 + 1] = t[x * 2 + 1] ^ (~t[a + 1] & t[b + 1]);
        }
      }
      // ι
      s[0] ^= RC[round * 2];
      s[1] ^= RC[round * 2 + 1];
    }
  }

  function keccak256Bytes(bytes) {
    const RATE = 136;                       // 1088 бит для keccak-256
    const state = new Int32Array(50);
    const pad = new Uint8Array(Math.ceil((bytes.length + 1) / RATE) * RATE);
    pad.set(bytes);
    pad[bytes.length] = 0x01;               // именно keccak, не SHA-3
    pad[pad.length - 1] |= 0x80;
    for (let off = 0; off < pad.length; off += RATE) {
      for (let i = 0; i < RATE / 4; i++) {
        state[i] ^= pad[off + i * 4] | (pad[off + i * 4 + 1] << 8) |
                    (pad[off + i * 4 + 2] << 16) | (pad[off + i * 4 + 3] << 24);
      }
      keccakF(state);
    }
    let out = '';
    for (let i = 0; i < 8; i++) {
      const v = state[i];
      out += ((v & 0xff).toString(16).padStart(2, '0')) +
             (((v >>> 8) & 0xff).toString(16).padStart(2, '0')) +
             (((v >>> 16) & 0xff).toString(16).padStart(2, '0')) +
             (((v >>> 24) & 0xff).toString(16).padStart(2, '0'));
    }
    return '0x' + out;
  }

  function keccak256(input) {
    let bytes;
    if (typeof input === 'string' && /^0x[0-9a-fA-F]*$/.test(input)) {
      const h = input.slice(2);
      bytes = new Uint8Array(h.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(h.substr(i * 2, 2), 16);
      }
    } else if (typeof input === 'string') {
      bytes = new TextEncoder().encode(input);
    } else {
      bytes = input;
    }
    return keccak256Bytes(bytes);
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { keccak256 };
  if (root) root.keccak256 = keccak256;
})(typeof window !== 'undefined' ? window : null);
