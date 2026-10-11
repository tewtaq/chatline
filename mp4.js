/* Chatline MP4 tools, shared by the app (index.html) and the PC page (pc.html).

   iPhones record clips as "fragmented" MP4: a header with empty sample tables, then one-second
   pieces (moof + mdat), and no total length. Windows Media Player can't seek those. fixMp4 reads
   every piece's sample list and writes one normal MP4: ftyp, a moov with full sample tables and
   the real length, then all the media in one mdat.

   keepSec (optional) also trims the clip to its last keepSec seconds, starting on a video keyframe
   (so it can come out a little longer when keyframes are far apart).

   Returns { data: Uint8Array, dur: seconds }, or null if the file isn't fragmented MP4.
   Throws if the file is damaged. */
(function(){
"use strict";

function fixMp4(buf, keepSec){
  const dv = new DataView(buf), u8 = new Uint8Array(buf);
  const str = (o, n) => String.fromCharCode(...u8.subarray(o, o + n));
  function list(s, e){
    const out = [];
    for (let o = s; o + 8 <= e; ){
      let size = dv.getUint32(o), hdr = 8;
      if (size === 1){ size = Number(dv.getBigUint64(o + 8)); hdr = 16; } else if (size === 0) size = e - o;
      if (size < hdr || o + size > e) throw new Error("bad box at " + o);
      out.push({ t: str(o + 4, 4), s: o, e: o + size, d: o + hdr });
      o += size;
    }
    return out;
  }
  const kids = b => list(b.d, b.e);
  const one = (b, t) => kids(b).find(x => x.t === t);
  const raw = b => u8.slice(b.s, b.e);
  const top = list(0, buf.byteLength);
  const ftyp = top.find(b => b.t === "ftyp"), moov = top.find(b => b.t === "moov");
  const moofs = top.filter(b => b.t === "moof");
  if (!ftyp || !moov || !moofs.length) return null;

  const mvhd = one(moov, "mvhd"), movieTs = dv.getUint32(mvhd.d + (u8[mvhd.d] ? 20 : 12));
  const trex = new Map();
  const mvex = one(moov, "mvex");
  if (mvex) for (const x of kids(mvex).filter(b => b.t === "trex")){
    trex.set(dv.getUint32(x.d + 4), { dur: dv.getUint32(x.d + 12), size: dv.getUint32(x.d + 16), flags: dv.getUint32(x.d + 20) });
  }
  const tracks = new Map();
  for (const tk of kids(moov).filter(b => b.t === "trak")){
    const tkhd = one(tk, "tkhd"), mdia = one(tk, "mdia"), mdhd = one(mdia, "mdhd"), hdlr = one(mdia, "hdlr");
    const id = dv.getUint32(tkhd.d + (u8[tkhd.d] ? 20 : 12));
    tracks.set(id, { id, trak: tk, ts: dv.getUint32(mdhd.d + (u8[mdhd.d] ? 20 : 12)),
      vide: str(hdlr.d + 8, 4) === "vide", time: 0, samples: [] });
  }

  // every sample, from every piece: its time, size, keyframe flag and where its bytes are
  let run = 0;
  for (const moof of moofs){
    let after = moof.s;
    for (const traf of kids(moof).filter(b => b.t === "traf")){
      const k = kids(traf), tfhd = k.find(b => b.t === "tfhd");
      const ff = dv.getUint32(tfhd.d) & 0xffffff, T = tracks.get(dv.getUint32(tfhd.d + 4));
      if (!T) continue;
      const X = trex.get(T.id) || {};
      let p = tfhd.d + 8, base, dDur = X.dur || 0, dSize = X.size || 0, dFlags = X.flags || 0;
      if (ff & 1){ base = Number(dv.getBigUint64(p)); p += 8; } else base = (ff & 0x20000) ? moof.s : after;
      if (ff & 2) p += 4;
      if (ff & 8){ dDur = dv.getUint32(p); p += 4; }
      if (ff & 0x10){ dSize = dv.getUint32(p); p += 4; }
      if (ff & 0x20){ dFlags = dv.getUint32(p); p += 4; }
      const tfdt = k.find(b => b.t === "tfdt");
      if (tfdt) T.time = u8[tfdt.d] ? Number(dv.getBigUint64(tfdt.d + 4)) : dv.getUint32(tfdt.d + 4);
      let pos = base;
      for (const tr of k.filter(b => b.t === "trun")){
        const rf = dv.getUint32(tr.d) & 0xffffff, v1 = u8[tr.d] === 1, n = dv.getUint32(tr.d + 4);
        let q = tr.d + 8, first = null;
        if (rf & 1){ pos = base + dv.getInt32(q); q += 4; }
        if (rf & 4){ first = dv.getUint32(q); q += 4; }
        let bytes = 0;
        for (let i = 0; i < n; i++){
          let dur = dDur, size = dSize, flags = dFlags, cto = 0;
          if (rf & 0x100){ dur = dv.getUint32(q); q += 4; }
          if (rf & 0x200){ size = dv.getUint32(q); q += 4; }
          if (rf & 0x400){ flags = dv.getUint32(q); q += 4; }
          if (rf & 0x800){ cto = v1 ? dv.getInt32(q) : dv.getUint32(q); q += 4; }
          if (i === 0 && first !== null) flags = first;
          T.samples.push({ dur, size, sync: !(flags & 0x10000), cto, t: T.time, src: pos + bytes, run });
          T.time += dur;
          bytes += size;
        }
        if (pos + bytes > buf.byteLength) throw new Error("sample data runs past the end");
        pos += bytes;
        run++;
      }
      after = pos;
    }
  }

  let all = [...tracks.values()].filter(T => T.samples.length);
  if (!all.length) return null;

  // keep only the end: from the last video keyframe at or before (end - keepSec)
  if (keepSec > 0){
    const end = Math.max(...all.map(T => { const s = T.samples[T.samples.length - 1]; return (s.t + s.dur) / T.ts; }));
    const V = all.find(T => T.vide);
    if (V){
      let cut = 0;
      V.samples.forEach((s, i) => { if (s.sync && s.t / V.ts <= end - keepSec) cut = i; });
      if (cut > 0){
        const at = V.samples[cut].t / V.ts;
        for (const T of all) T.samples = T === V ? T.samples.slice(cut) : T.samples.filter(s => (s.t + s.dur) / T.ts > at);
        all = all.filter(T => T.samples.length);
      }
    }
  }

  // group each track's samples back into runs of neighbouring bytes ("chunks")
  for (const T of all){
    T.start = T.samples[0].t;
    T.dur = T.samples.reduce((n, s) => n + s.dur, 0);
    T.chunks = [];
    let c = null;
    for (const s of T.samples){
      if (c && s.run === c.run && s.src === c.src + c.bytes){ c.bytes += s.size; c.n++; }
      else { c = { run: s.run, src: s.src, bytes: s.size, n: 1, out: 0 }; T.chunks.push(c); }
    }
  }

  // writing boxes
  const cat = parts => { let n = 0; for (const p of parts) n += p.length; const o = new Uint8Array(n); let i = 0; for (const p of parts){ o.set(p, i); i += p.length; } return o; };
  const u32s = arr => { const o = new Uint8Array(arr.length * 4), d = new DataView(o.buffer); arr.forEach((v, i) => d.setUint32(i * 4, v >>> 0)); return o; };
  const box = (t, ...parts) => { const body = cat(parts), o = new Uint8Array(8 + body.length); new DataView(o.buffer).setUint32(0, o.length); for (let i = 0; i < 4; i++) o[4 + i] = t.charCodeAt(i); o.set(body, 8); return o; };
  const full = (t, v, f, ...parts) => box(t, u32s([(v << 24) | f]), ...parts);
  const patched = (b, at, v64, value) => { const o = raw(b), d = new DataView(o.buffer), off = (b.d - b.s) + at; if (v64) d.setBigUint64(off, BigInt(value)); else d.setUint32(off, value >>> 0); return o; };
  const rle = vals => { const out = []; for (const v of vals){ if (out.length && out[out.length - 1][1] === v) out[out.length - 1][0]++; else out.push([1, v]); } return out; };
  const toMovie = (v, ts) => Math.round(v * movieTs / ts);

  // the clip starts at 0; a track that starts later gets an empty edit first
  const base = Math.min(...all.map(T => T.start / T.ts));
  const chunks = all.flatMap(T => T.chunks).sort((a, b) => a.src - b.src);
  const mediaBytes = chunks.reduce((n, c) => n + c.bytes, 0);
  let movieDur = 0;
  for (const T of all){
    T.startM = Math.round((T.start / T.ts - base) * movieTs);
    T.durM = toMovie(T.dur, T.ts);
    movieDur = Math.max(movieDur, T.startM + T.durM);
  }

  function stbl(T, stsd){
    const S = T.samples, parts = [raw(stsd)];
    parts.push(full("stts", 0, 0, u32s([...(r => [r.length, ...r.flat()])(rle(S.map(s => s.dur)))])));
    if (S.some(s => s.cto)){
      const neg = S.some(s => s.cto < 0), r = rle(S.map(s => s.cto));
      parts.push(full("ctts", neg ? 1 : 0, 0, u32s([r.length, ...r.flat()])));
    }
    if (T.vide && S.some(s => !s.sync)){
      const idx = []; S.forEach((s, i) => { if (s.sync) idx.push(i + 1); });
      parts.push(full("stss", 0, 0, u32s([idx.length, ...idx])));
    }
    const sc = []; T.chunks.forEach((c, i) => { if (!sc.length || sc[sc.length - 1][1] !== c.n) sc.push([i + 1, c.n, 1]); });
    parts.push(full("stsc", 0, 0, u32s([sc.length, ...sc.flat()])));
    parts.push(full("stsz", 0, 0, u32s([0, S.length, ...S.map(s => s.size)])));
    parts.push(full("stco", 0, 0, u32s([T.chunks.length, ...T.chunks.map(c => c.out)])));
    return box("stbl", ...parts);
  }
  function trak(T){
    const parts = [];
    for (const b of kids(T.trak)){
      if (b.t === "tkhd"){
        parts.push(patched(b, u8[b.d] ? 28 : 20, !!u8[b.d], T.startM + T.durM));
        const mt = T.samples[0].cto || 0;
        if (T.startM || mt){
          const e = []; if (T.startM) e.push(T.startM, -1, 0x00010000); e.push(T.durM, mt, 0x00010000);
          parts.push(box("edts", full("elst", 0, 0, u32s([e.length / 3, ...e]))));
        }
      } else if (b.t === "mdia"){
        const m = [];
        for (const c of kids(b)){
          if (c.t === "mdhd") m.push(patched(c, u8[c.d] ? 24 : 16, !!u8[c.d], T.dur));
          else if (c.t === "minf"){
            const f = [];
            for (const g of kids(c)) f.push(g.t === "stbl" ? stbl(T, one(g, "stsd")) : raw(g));
            m.push(box("minf", ...f));
          } else m.push(raw(c));
        }
        parts.push(box("mdia", ...m));
      } else if (b.t !== "edts") parts.push(raw(b));
    }
    return box("trak", ...parts);
  }
  function buildMoov(){
    const parts = [];
    for (const b of kids(moov)){
      if (b.t === "mvhd") parts.push(patched(b, u8[b.d] ? 24 : 16, !!u8[b.d], movieDur));
      else if (b.t === "trak"){ const T = all.find(x => x.trak.s === b.s); if (T) parts.push(trak(T)); }
      else if (b.t !== "mvex") parts.push(raw(b));
    }
    return box("moov", ...parts);
  }
  // lay out the media, then write the header with where each piece now sits
  const ft = raw(ftyp);
  const moovSize = buildMoov().length;
  let at = ft.length + moovSize + 8;
  for (const c of chunks){ c.out = at; at += c.bytes; }
  if (at > 0xffffffff) throw new Error("too big");
  const out = new Uint8Array(at);
  out.set(ft, 0);
  const mv = buildMoov(); out.set(mv, ft.length);
  const mdatAt = ft.length + mv.length;
  new DataView(out.buffer).setUint32(mdatAt, 8 + mediaBytes);
  out.set([109, 100, 97, 116], mdatAt + 4); // "mdat"
  for (const c of chunks) out.set(u8.subarray(c.src, c.src + c.bytes), c.out);
  return { data: out, dur: movieDur / movieTs };
}

// self = the page, or a background worker (the PC page fixes long recordings in one)
self.chatlineMp4 = { fixMp4 };
})();
