#!/usr/bin/env python3
"""
Carbon Native V2 - Standalone FlatBuffers Code Generator Tool
Generates C++, Rust, Go, TS, and C# bindings from FlatBuffers IDL (.fbs) files.
"""

import sys
import subprocess
import argparse
from pathlib import Path

def generate_flatbuffers(schema_dir: Path, output_dir: Path, languages: list):
    flatc = "flatc"
    fbs_files = list(schema_dir.glob("*.fbs"))
    
    if not fbs_files:
        print(f"[!] No .fbs files found in {schema_dir}")
        return

    lang_flags = {
        "cpp": ["--cpp", "--gen-mutable", "--gen-object-api"],
        "rust": ["--rust"],
        "go": ["--go"],
        "ts": ["--ts"],
        "csharp": ["--csharp"],
    }

    output_dir.mkdir(parents=True, exist_ok=True)

    for lang in languages:
        if lang not in lang_flags:
            print(f"[!] Unsupported language: {lang}")
            continue

        target_out = output_dir / lang
        target_out.mkdir(parents=True, exist_ok=True)
        
        cmd = [flatc] + lang_flags[lang] + ["-o", str(target_out)] + [str(f) for f in fbs_files]
        print(f"[*] Generating {lang.upper()} contracts: {' '.join(cmd)}")
        
        try:
            subprocess.run(cmd, check=True)
            print(f"[+] Successfully generated {lang.upper()} bindings in {target_out}")
        except FileNotFoundError:
            print(f"[!] Error: '{flatc}' executable not found in PATH.")
            break
        except subprocess.CalledProcessError as e:
            print(f"[!] Generation failed for {lang}: {e}")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Carbon Native V2 FlatBuffers Generator")
    parser.add_argument("--schema-dir", default="solutions/shared/idl", help="Directory containing .fbs files")
    parser.add_argument("--output-dir", default=".tools/generators/out/idl", help="Output directory for generated bindings")
    parser.add_argument("--langs", nargs="+", default=["cpp", "rust", "go", "ts", "csharp"], help="Languages to generate")
    
    args = parser.parse_args()
    generate_flatbuffers(Path(args.schema_dir), Path(args.output_dir), args.langs)
