import struct, sys

def parse(path):
    with open(path, 'rb') as f:
        data = f.read()
    sig, ver, nstreams, diroff = struct.unpack_from('<4sIII', data, 0)
    print(path, 'sig', sig, 'streams', nstreams)
    for i in range(nstreams):
        stype, dsize, doff = struct.unpack_from('<III', data, diroff + i * 12)
        if stype == 6:  # ExceptionStream
            tid = struct.unpack_from('<I', data, doff)[0]
            exc_off = doff + 8
            code, flags, rec, addr, nparams = struct.unpack_from('<IIQQI', data, exc_off)
            params = struct.unpack_from('<15Q', data, exc_off + 36)
            print('  EXCEPTION code=0x%08X addr=0x%016X thread=%d' % (code, addr, tid))
            print('  params[:4]=', [hex(p) for p in params[:4]])
        if stype == 4:  # ModuleListStream
            nmod = struct.unpack_from('<I', data, doff)[0]
            print('  %d modules' % nmod)
            for j in range(nmod):
                moff = doff + 4 + j * 108
                base = struct.unpack_from('<Q', data, moff)[0]
                size, cksum, ts, name_rva = struct.unpack_from('<IIII', data, moff + 8)
                nlen = struct.unpack_from('<I', data, name_rva)[0]
                name = data[name_rva + 4:name_rva + 4 + nlen].decode('utf-16-le', 'replace')
                ln = name.lower()
                if any(k in ln for k in ('tau', 'webview', 'embedded', 'd3d', 'dxgi', 'ntdll')):
                    print('    %s base=0x%X size=0x%X' % (name, base, size))

for p in sys.argv[1:]:
    parse(p)
    print()
