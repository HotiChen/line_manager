#!/usr/bin/env python3
"""
Debug 代碼清理工具
自動移除 console.log 和 debugger 語句
保留 console.error 和 console.warn
"""

import os
import re
import sys
from pathlib import Path
from typing import List, Dict, Tuple

class DebugCleaner:
    def __init__(self, base_dir: str):
        self.base_dir = Path(base_dir)
        self.stats = {
            'files_scanned': 0,
            'files_modified': 0,
            'console_log_removed': 0,
            'debugger_removed': 0,
            'lines_removed': 0
        }
        self.report = []
        
    def scan_directory(self, directory: str = 'js') -> List[Path]:
        """掃描目錄下所有 JS 檔案"""
        js_dir = self.base_dir / directory
        return list(js_dir.glob('**/*.js'))
    
    def should_preserve_line(self, line: str) -> bool:
        """判斷是否應該保留該行"""
        # 保留 console.error 和 console.warn
        if 'console.error' in line or 'console.warn' in line:
            return True
        
        # 保留註解掉的 console.log
        stripped = line.strip()
        if stripped.startswith('//') and 'console.log' in stripped:
            return True
            
        return False
    
    def clean_file(self, file_path: Path, dry_run: bool = False) -> Dict:
        """清理單個檔案"""
        result = {
            'path': str(file_path.relative_to(self.base_dir)),
            'console_log_removed': 0,
            'debugger_removed': 0,
            'lines_removed': 0,
            'modified': False
        }
        
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                lines = f.readlines()
        except Exception as e:
            print(f"❌ 讀取失敗 {file_path}: {e}")
            return result
        
        new_lines = []
        i = 0
        
        while i < len(lines):
            line = lines[i]
            original_line = line
            should_remove = False
            
            # 檢查 debugger
            if re.search(r'\bdebugger\s*;?\s*$', line.strip()):
                should_remove = True
                result['debugger_removed'] += 1
                result['lines_removed'] += 1
            
            # 檢查 console.log (但要保留 error/warn)
            elif 'console.log' in line and not self.should_preserve_line(line):
                should_remove = True
                result['console_log_removed'] += 1
                result['lines_removed'] += 1
            
            if not should_remove:
                new_lines.append(line)
            
            i += 1
        
        # 如果有修改且不是 dry run
        if len(new_lines) != len(lines):
            result['modified'] = True
            
            if not dry_run:
                try:
                    with open(file_path, 'w', encoding='utf-8') as f:
                        f.writelines(new_lines)
                    print(f"✅ {result['path']}: 移除 {result['console_log_removed']} console.log, {result['debugger_removed']} debugger")
                except Exception as e:
                    print(f"❌ 寫入失敗 {file_path}: {e}")
                    result['modified'] = False
            else:
                print(f"🔍 [DRY RUN] {result['path']}: 將移除 {result['console_log_removed']} console.log, {result['debugger_removed']} debugger")
        
        return result
    
    def clean_all(self, directory: str = 'js', dry_run: bool = False):
        """清理所有檔案"""
        print(f"\n{'='*60}")
        print(f"🧹 Debug 代碼清理工具")
        print(f"{'='*60}")
        print(f"📂 掃描目錄: {directory}")
        print(f"🔍 模式: {'DRY RUN (僅預覽)' if dry_run else 'EXECUTE (實際修改)'}")
        print(f"{'='*60}\n")
        
        files = self.scan_directory(directory)
        print(f"📄 找到 {len(files)} 個 JS 檔案\n")
        
        for file_path in files:
            self.stats['files_scanned'] += 1
            result = self.clean_file(file_path, dry_run)
            
            if result['modified']:
                self.stats['files_modified'] += 1
                self.stats['console_log_removed'] += result['console_log_removed']
                self.stats['debugger_removed'] += result['debugger_removed']
                self.stats['lines_removed'] += result['lines_removed']
                self.report.append(result)
    
    def print_report(self):
        """列印清理報告"""
        print(f"\n{'='*60}")
        print(f"📊 清理報告")
        print(f"{'='*60}")
        print(f"📁 掃描檔案數: {self.stats['files_scanned']}")
        print(f"✏️  修改檔案數: {self.stats['files_modified']}")
        print(f"🗑️  移除 console.log: {self.stats['console_log_removed']}")
        print(f"🗑️  移除 debugger: {self.stats['debugger_removed']}")
        print(f"📉 總共移除行數: {self.stats['lines_removed']}")
        print(f"{'='*60}\n")
        
        if self.report:
            print("📋 修改的檔案詳情：\n")
            for item in sorted(self.report, key=lambda x: x['lines_removed'], reverse=True):
                print(f"  📄 {item['path']}")
                print(f"     - console.log: {item['console_log_removed']}")
                print(f"     - debugger: {item['debugger_removed']}")
                print(f"     - 總行數: {item['lines_removed']}")
                print()

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description='移除 Debug 代碼')
    parser.add_argument('--dry-run', action='store_true', help='僅預覽，不實際修改')
    parser.add_argument('--dir', default='js', help='要掃描的目錄 (預設: js)')
    
    args = parser.parse_args()
    
    # 取得專案根目錄
    base_dir = Path(__file__).parent.parent
    
    cleaner = DebugCleaner(base_dir)
    cleaner.clean_all(directory=args.dir, dry_run=args.dry_run)
    cleaner.print_report()
    
    if args.dry_run:
        print("\n💡 這是 DRY RUN 模式，沒有實際修改任何檔案")
        print("💡 執行 'python3 scripts/remove_debug_logs.py' 以實際清理\n")

if __name__ == '__main__':
    main()
