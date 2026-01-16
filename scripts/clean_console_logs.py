#!/usr/bin/env python3
"""
Console.log 清理腳本
- 刪除 console.log 和 console.debug
- 保留 console.error, console.warn, console.info
- 處理單行和註解的 console.log
"""

import re
import os
import sys

def clean_console_logs(file_path):
    """清理檔案中的 console.log"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        original_lines = content.split('\n')
        new_lines = []
        skip_next = False
        removed_count = 0
        
        for i, line in enumerate(original_lines):
            #保留 console.error, console.warn, console.info
            if re.search(r'console\.(error|warn|info)', line):
                new_lines.append(line)
                continue
            
            # 刪除註解的 console.log
            if re.search(r'^\s*//.*console\.log\(', line):
                removed_count += 1
                continue
            
            # 刪除 console.log 和 console.debug
            if re.search(r'console\.(log|debug)\(', line):
                removed_count += 1
                # 檢查是否是單行
                if line.strip().endswith(');') or line.strip().endswith(')'):
                    continue
                else:
                    # 多行的情況，標記跳過下一行
                    skip_next = True
                    continue
            
            # 跳過多行 console.log 的後續行
            if skip_next:
                if ');' in line or ')' in line:
                    skip_next = False
                continue
            
            new_lines.append(line)
        
        # 寫回檔案
        if removed_count > 0:
            with open(file_path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(new_lines))
            return removed_count
        return 0
        
    except Exception as e:
        print(f"Error processing {file_path}: {e}")
        return 0

def main():
    base_dir = "/Volumes/Tim 1TB SSD/vs code/new line project/frontend_backup_V1.0"
    
    # 要處理的目錄
    directories = ['js', 'worker_src', 'helper']
    
    total_removed = 0
    files_processed = 0
    
    for directory in directories:
        dir_path = os.path.join(base_dir, directory)
        
        for root, dirs, files in os.walk(dir_path):
            for file in files:
                if file.endswith('.js'):
                    file_path = os.path.join(root, file)
                    removed = clean_console_logs(file_path)
                    if removed > 0:
                        rel_path = os.path.relpath(file_path, base_dir)
                        print(f"✓ {rel_path}: removed {removed} console.log(s)")
                        total_removed += removed
                        files_processed += 1
    
    print(f"\n📊 Summary:")
    print(f"   Files processed: {files_processed}")
    print(f"   Total console.log removed: {total_removed}")
    print(f"\n✅ Cleanup complete!")

if __name__ == "__main__":
    main()
