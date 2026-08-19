import struct, sys, array
from collections import Counter

data = open(sys.argv[1], 'rb').read()
sig, ver, ns, diroff = struct.unpack_from('<4sIII', data, 0)
streams = {}
for i in range(ns):
    st, ds, do = struct.unpack_from('<III', data, diroff + i * 12)
    streams.setdefault(st, []).append((do, ds))

doff, _ = streams[4][0]
nmod = struct.unpack_from('<I', data, doff)[0]
mods = []
for j in range(nmod):
    mo = doff + 4 + j * 108
    base = struct.unpack_from('<Q', data, mo)[0]
    size, ck, ts, nrva = struct.unpack_from('<IIII', data, mo + 8)
    nl = struct.unpack_from('<I', data, nrva)[0]
    name = data[nrva + 4:nrva + 4 + nl].decode('utf-16-le', 'replace')
    name = name.replace('\\', '/').split('/')[-1]
    mods.append((base, base + size, name))

def resolve(a):
    for lo, hi, n in mods:
        if lo <= a < hi:
            return '%s+0x%X' % (n, a - lo)
    return None

doff, _ = streams[5][0]
n = struct.unpack_from('<I', data, doff)[0]
mems = []
for j in range(n):
    eo = doff + 4 + j * 16
    start = struct.unpack_from('<Q', data, eo)[0]
    rva, sz = struct.unpack_from('<II', data, eo + 8)
    mems.append((start, rva, sz))
print('memory regions:', n)

# crash thread RSP from exception stream
doff, _ = streams[6][0]
ctx_sz, ctx_rva = struct.unpack_from('<II', data, doff + 8 + 152)
rsp = struct.unpack_from('<Q', data, ctx_rva + 0x98)[0]
rip = struct.unpack_from('<Q', data, ctx_rva + 0xF8)[0]
print('RIP=%s' % (resolve(rip) or hex(rip)))

# scan only the region containing RSP (crash thread stack)
for start, rva, sz in mems:
    if not (start <= rsp < start + sz):
        continue
    print('stack region 0x%X..0x%X' % (start, start + sz))
    top = rsp - start
    cnt = Counter()
    uniq = {}
    arr = array.array('Q')
    arr.frombytes(data[rva + top:rva + sz - ((sz - top) % 8)])
    for i, val in enumerate(arr):
        # cheap pre-filter: module addresses share high bytes
        if 0x7FF000000000 <= val <= 0x7FFFFFFFFFFF:
            r = resolve(val)
            if r:
                off = top + i * 8 - top
                cnt[r.split('+')[0]] += 1
                if r not in uniq:
                    uniq[r] = off
    print('pointer counts by module:', dict(cnt))
    print('--- in stack order (offset from RSP):')
    for i, val in enumerate(arr):
        if 0x7FF000000000 <= val <= 0x7FFFFFFFFFFF:
            r = resolve(val)
            if r and (r.startswith('tau.exe') or r.startswith('EmbeddedBrowser')):
                print('  [rsp+0x%05X] %s' % (i * 8, r))
    break
