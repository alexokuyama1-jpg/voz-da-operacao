/* ============================================================
   qr.js — Gerador de QR Code (byte mode, EC nível M, versões 1–10)
   Implementação própria, sem dependências externas.
   ============================================================ */
'use strict';

const QRCode = (function () {

  /* ---- Campo de Galois GF(256) ---- */
  const EXP = new Array(512), LOG = new Array(256);
  (function () {
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ ((x & 0x80) ? 0x11d : 0); }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();
  const gmul = (a, b) => (a === 0 || b === 0) ? 0 : EXP[LOG[a] + LOG[b]];

  function genPoly(n) {
    let g = [1];
    for (let i = 0; i < n; i++) {
      const ng = new Array(g.length + 1).fill(0);
      for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= gmul(g[j], EXP[i]); }
      g = ng;
    }
    return g;
  }

  function rsEncode(data, ecLen) {
    const g = genPoly(ecLen);
    const res = new Array(ecLen).fill(0);
    for (let i = 0; i < data.length; i++) {
      const f = data[i] ^ res[0];
      res.shift(); res.push(0);
      if (f !== 0) for (let j = 0; j < ecLen; j++) res[j] ^= gmul(g[j + 1], f);
    }
    return res;
  }

  /* ---- Tabelas (nível de correção M) ---- */
  const VER = [null,
    { ec: 10, b: [[1, 16]] },
    { ec: 16, b: [[1, 28]] },
    { ec: 26, b: [[1, 44]] },
    { ec: 18, b: [[2, 32]] },
    { ec: 24, b: [[2, 43]] },
    { ec: 16, b: [[4, 27]] },
    { ec: 18, b: [[4, 31]] },
    { ec: 22, b: [[2, 38], [2, 39]] },
    { ec: 22, b: [[3, 36], [2, 37]] },
    { ec: 26, b: [[4, 43], [1, 44]] },
  ];
  const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
    [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r, c) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => ((((r * c) % 2) + ((r * c) % 3)) % 2) === 0,
    (r, c) => ((((r + c) % 2) + ((r * c) % 3)) % 2) === 0,
  ];

  function formatBits(mask) {
    const data = (0 << 3) | mask;          // 00 = nível M
    let v = data << 10;
    for (let i = 14; i >= 10; i--) if ((v >> i) & 1) v ^= 0x537 << (i - 10);
    return ((data << 10) | v) ^ 0x5412;
  }

  function versionBits(ver) {
    let rem = ver;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
    return (ver << 12) | rem;
  }

  /* ---- Penalidade (escolha da máscara) ---- */
  function penalty(m, n) {
    let p = 0;
    // Regra 1 — sequências de 5+
    for (let i = 0; i < n; i++) {
      let rc = 1, cc = 1;
      for (let j = 1; j < n; j++) {
        if (m[i][j] === m[i][j - 1]) { rc++; } else { if (rc >= 5) p += 3 + (rc - 5); rc = 1; }
        if (m[j][i] === m[j - 1][i]) { cc++; } else { if (cc >= 5) p += 3 + (cc - 5); cc = 1; }
      }
      if (rc >= 5) p += 3 + (rc - 5);
      if (cc >= 5) p += 3 + (cc - 5);
    }
    // Regra 2 — blocos 2x2
    for (let r = 0; r < n - 1; r++) for (let c = 0; c < n - 1; c++) {
      const v = m[r][c];
      if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) p += 3;
    }
    // Regra 3 — padrão 1:1:3:1:1
    const P1 = [1, 0, 1, 1, 1, 0, 1, 0, 0, 0, 0], P2 = [0, 0, 0, 0, 1, 0, 1, 1, 1, 0, 1];
    const match = (arr, pat) => pat.every((v, i) => arr[i] === v);
    for (let i = 0; i < n; i++) for (let j = 0; j <= n - 11; j++) {
      const row = [], col = [];
      for (let k = 0; k < 11; k++) { row.push(m[i][j + k]); col.push(m[j + k][i]); }
      if (match(row, P1) || match(row, P2)) p += 40;
      if (match(col, P1) || match(col, P2)) p += 40;
    }
    // Regra 4 — proporção de módulos escuros
    let dark = 0;
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) dark++;
    const pct = (dark * 100) / (n * n);
    p += Math.floor(Math.abs(pct - 50) / 5) * 10;
    return p;
  }

  /* ---- Geração ---- */
  function build(text) {
    const bytes = new TextEncoder().encode(text);

    let ver = 0, cap = 0;
    for (let v = 1; v <= 10; v++) {
      cap = VER[v].b.reduce((a, [k, d]) => a + k * d, 0);
      const cc = v < 10 ? 8 : 16;
      if (Math.ceil((4 + cc + bytes.length * 8) / 8) <= cap) { ver = v; break; }
    }
    if (!ver) throw new Error('Conteúdo muito longo para o QR Code.');

    const totalData = VER[ver].b.reduce((a, [k, d]) => a + k * d, 0);
    const bits = [];
    const push = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    push(4, 4);
    push(bytes.length, ver < 10 ? 8 : 16);
    for (const b of bytes) push(b, 8);
    for (let i = 0; i < 4 && bits.length < totalData * 8; i++) bits.push(0);
    while (bits.length % 8) bits.push(0);

    const cw = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      cw.push(v);
    }
    const pads = [0xEC, 0x11];
    let pi = 0;
    while (cw.length < totalData) cw.push(pads[pi++ % 2]);

    const blocks = [], ecs = [];
    let idx = 0;
    for (const [k, d] of VER[ver].b) {
      for (let i = 0; i < k; i++) {
        const blk = cw.slice(idx, idx + d); idx += d;
        blocks.push(blk); ecs.push(rsEncode(blk, VER[ver].ec));
      }
    }
    const final = [];
    const maxD = Math.max(...blocks.map(b => b.length));
    for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.length) final.push(b[i]);
    for (let i = 0; i < VER[ver].ec; i++) for (const e of ecs) final.push(e[i]);

    /* ---- Matriz ---- */
    const n = 17 + ver * 4;
    const m = Array.from({ length: n }, () => new Array(n).fill(0));
    const fn = Array.from({ length: n }, () => new Array(n).fill(false));

    const finder = (r, c) => {
      for (let dr = -1; dr <= 7; dr++) for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr, cc2 = c + dc;
        if (rr < 0 || rr >= n || cc2 < 0 || cc2 >= n) continue;
        const inSq = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
        let dark = false;
        if (inSq) dark = (dr === 0 || dr === 6 || dc === 0 || dc === 6) ||
                         (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4);
        m[rr][cc2] = dark ? 1 : 0; fn[rr][cc2] = true;
      }
    };
    finder(0, 0); finder(0, n - 7); finder(n - 7, 0);

    for (let i = 8; i < n - 8; i++) {
      const v = (i % 2 === 0) ? 1 : 0;
      m[6][i] = v; fn[6][i] = true;
      m[i][6] = v; fn[i][6] = true;
    }

    for (const r of ALIGN[ver]) for (const c of ALIGN[ver]) {
      if ((r <= 8 && c <= 8) || (r <= 8 && c >= n - 9) || (r >= n - 9 && c <= 8)) continue;
      for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
        m[r + dr][c + dc] = (Math.abs(dr) === 2 || Math.abs(dc) === 2 || (dr === 0 && dc === 0)) ? 1 : 0;
        fn[r + dr][c + dc] = true;
      }
    }

    for (let i = 0; i < 9; i++) {
      if (!fn[8][i]) { fn[8][i] = true; }
      if (!fn[i][8]) { fn[i][8] = true; }
    }
    for (let i = 0; i < 8; i++) {
      if (!fn[8][n - 1 - i]) fn[8][n - 1 - i] = true;
      if (!fn[n - 1 - i][8]) fn[n - 1 - i][8] = true;
    }
    m[n - 8][8] = 1; fn[n - 8][8] = true;

    if (ver >= 7) {
      for (let i = 0; i < 18; i++) {
        const a = n - 11 + (i % 3), b = Math.floor(i / 3);
        fn[b][a] = true; fn[a][b] = true;
      }
    }

    const dataBits = [];
    for (const c of final) for (let i = 7; i >= 0; i--) dataBits.push((c >> i) & 1);
    let bi = 0, up = true;
    for (let col = n - 1; col > 0; col -= 2) {
      if (col === 6) col--;
      for (let k = 0; k < n; k++) {
        const row = up ? n - 1 - k : k;
        for (let s = 0; s < 2; s++) {
          const cc2 = col - s;
          if (fn[row][cc2]) continue;
          m[row][cc2] = bi < dataBits.length ? dataBits[bi++] : 0;
        }
      }
      up = !up;
    }

    const placeFormat = (mm, fmt) => {
      for (let i = 0; i <= 5; i++) mm[i][8] = (fmt >> i) & 1;
      mm[7][8] = (fmt >> 6) & 1;
      mm[8][8] = (fmt >> 7) & 1;
      mm[8][7] = (fmt >> 8) & 1;
      for (let i = 9; i < 15; i++) mm[8][14 - i] = (fmt >> i) & 1;
      for (let i = 0; i < 8; i++) mm[8][n - 1 - i] = (fmt >> i) & 1;
      for (let i = 8; i < 15; i++) mm[n - 15 + i][8] = (fmt >> i) & 1;
      mm[n - 8][8] = 1;
    };
    const placeVersion = (mm) => {
      if (ver < 7) return;
      const vb = versionBits(ver);
      for (let i = 0; i < 18; i++) {
        const bit = (vb >> i) & 1;
        const a = n - 11 + (i % 3), b = Math.floor(i / 3);
        mm[b][a] = bit; mm[a][b] = bit;
      }
    };

    let best = null, bestScore = Infinity;
    for (let k = 0; k < 8; k++) {
      const mm = m.map(r => r.slice());
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++)
        if (!fn[r][c] && MASKS[k](r, c)) mm[r][c] ^= 1;
      placeFormat(mm, formatBits(k));
      placeVersion(mm);
      const sc = penalty(mm, n);
      if (sc < bestScore) { bestScore = sc; best = mm; }
    }
    return { size: n, modules: best };
  }

  /* ---- Saídas ---- */
  function toSVG(text, opts) {
    const o = Object.assign({ size: 260, margin: 4, dark: '#04336b', light: '#ffffff' }, opts || {});
    const q = build(text);
    const total = q.size + o.margin * 2;
    const scale = o.size / total;
    let path = '';
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++)
      if (q.modules[r][c]) path += `M${c + o.margin} ${r + o.margin}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${o.size}" height="${o.size}" viewBox="0 0 ${total} ${total}" shape-rendering="crispEdges">`
      + `<rect width="${total}" height="${total}" fill="${o.light}"/>`
      + `<path d="${path}" fill="${o.dark}"/></svg>`;
  }

  function toCanvas(text, opts) {
    const o = Object.assign({ size: 512, margin: 4, dark: '#04336b', light: '#ffffff' }, opts || {});
    const q = build(text);
    const total = q.size + o.margin * 2;
    const px = Math.max(1, Math.floor(o.size / total));
    const cv = document.createElement('canvas');
    cv.width = cv.height = total * px;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = o.light; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.fillStyle = o.dark;
    for (let r = 0; r < q.size; r++) for (let c = 0; c < q.size; c++)
      if (q.modules[r][c]) ctx.fillRect((c + o.margin) * px, (r + o.margin) * px, px, px);
    return cv;
  }

  return { build, toSVG, toCanvas };
})();
