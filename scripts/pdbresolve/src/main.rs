use pdb::{FallibleIterator, PDB};
use std::fs::File;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let pdb_path = &args[1];
    let addrs: Vec<u32> = args[2..]
        .iter()
        .map(|a| u32::from_str_radix(a.trim_start_matches("0x"), 16).unwrap())
        .collect();
    let file = File::open(pdb_path).unwrap();
    let mut pdb = PDB::open(file).unwrap();
    let address_map = pdb.address_map().unwrap();
    let mut syms: Vec<(u32, String)> = Vec::new();
    let symbol_table = pdb.global_symbols().unwrap();
    let mut symbols = symbol_table.iter();
    while let Some(sym) = symbols.next().unwrap() {
        if let Ok(pdb::SymbolData::Public(data)) = sym.parse() {
            if data.function {
                if let Some(rva) = data.offset.to_rva(&address_map) {
                    syms.push((rva.0, data.name.to_string().into_owned()));
                }
            }
        }
    }
    let dbi = pdb.debug_information().unwrap();
    let mut modules = dbi.modules().unwrap();
    while let Some(module) = modules.next().unwrap() {
        if let Ok(Some(info)) = pdb.module_info(&module) {
            if let Ok(mut iter) = info.symbols() {
                while let Ok(Some(sym)) = iter.next() {
                    if let Ok(pdb::SymbolData::Procedure(data)) = sym.parse() {
                        if let Some(rva) = data.offset.to_rva(&address_map) {
                            syms.push((rva.0, data.name.to_string().into_owned()));
                        }
                    }
                }
            }
        }
    }
    syms.sort_by_key(|(r, _)| *r);
    for &rva in &addrs {
        let idx = syms.partition_point(|(r, _)| *r <= rva);
        if idx == 0 {
            println!("0x{:X}: (before first symbol)", rva);
        } else {
            let (r, name) = &syms[idx - 1];
            println!("0x{:X}: {} +0x{:X}", rva, name, rva - r);
        }
    }
}
