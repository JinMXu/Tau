import struct, sys

path = sys.argv[1]
data = open(path, 'rb').read()
sig, ver, nstreams, diroff = struct.unpack_from('<4sIII', data, 0)

streams = {}
for i in range(nstreams):
    stype, dsize, doff = struct.unpack_from('<III', data, diroff + i * 12)
    streams.setdefault(stype, []).append((doff, dsize))

# modules
mods = []
doff, dsize = streams[4][0]
nmod = struct.unpack_from('<I', data, doff)[0]
for j in range(nmod):
    moff = doff + 4 + j * 108
    base = struct.unpack_from('<Q', data, moff)[0]
    size, cksum, ts, name_rva = struct.unpack_from('<IIII', data, moff + 8)
    nlen = struct.unpack_from('<I', data, name_rva)[0]
    name = data[name_rva + 4:name_rva + 4 + nlen].decode('utf-16-le', 'replace')
    mods.append((base, base + size, name.split('\\')[-1]))

def resolve(addr):
    for lo, hi, name in mods:
        if lo <= addr < hi:
            return '%s+0x%X' % (name, addr - lo)
    return None

# memory list (stream 5): count(8 for 64? actually 4) then entries (start 8, rva 4, size 4)
mems = []
if 5 in streams:
    doff, dsize = streams[5][0]
    n = struct.unpack_from('<I', data, doff)[0]
    for j in range(n):
        eoff = doff + 4 + j * 16
        start = struct.unpack_from('<Q', data, eoff)[0]
        rva, sz = struct.unpack_from('<II', data, eoff + 8)
        mems.append((start, rva, sz))

def readmem(addr, length):
    for start, rva, sz in mems:
        if start <= addr and addr + length <= start + sz:
            off = rva + (addr - start)
            return data[off:off + length]
    return None

# exception stream
doff, dsize = streams[6][0]
tid = struct.unpack_from('<I', data, doff)[0]
ctx_sz, ctx_rva = struct.unpack_from('<II', data, doff + 8 + 152)
print('crash thread tid=%d ctx at 0x%X size %d' % (tid, ctx_rva, ctx_sz))
# x64 CONTEXT: RIP at offset 0xF8, RSP 0x98, RBP 0xA0
rip = struct.unpack_from('<Q', data, ctx_rva + 0xF8)[0]
rsp = struct.unpack_from('<Q', data, ctx_rva + 0x98)[0]
rbp = struct.unpack_from('<Q', data, ctx_rva + 0xA0)[0]
print('RIP=0x%016X (%s)' % (rip, resolve(rip) or '?'))
print('RSP=0x%016X RBP=0x%016X' % (rsp, rbp))

# find stack memory region containing rsp
stack = None
for start, rva, sz in mems:
    if start <= rsp < start + sz:
        stack = (start, rva, sz)
if stack:
    start, rva, sz = stack
    print('stack region 0x%X..0x%X (%d bytes)' % (start, start + sz, sz))
    top = rsp - start
    end = min(sz, top + 0x2000)
    print('candidate return addresses above RSP:')
    for off in range(top, end, 8):
        val = struct.unpack_from('<Q', data, rva + off)[0]
        r = resolve(val)
        if r:
            print('  [rsp+0x%04X] 0x%016X %s' % (off - top, val, r))
else:
    print('no stack region in dump')
