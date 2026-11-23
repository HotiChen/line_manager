// js/flow/history.js
// Undo / Redo：每次「變動完成之後」record 一份快照。
//
// 舊實作在變動「之前」推快照，導致 undo 一次跳兩步、redo 回到變動前 —— 這裡的規則是：
//   entries[index] 永遠等於「目前畫面」的狀態。
//   undo → index-1；redo → index+1；record → 丟掉 index 之後的分支再推入。

export class History {
    constructor(limit = 50) {
        this.limit = limit;
        this.entries = [];
        this.index = -1;
    }

    /** 以目前狀態作為唯一起點（載入、清空之後） */
    reset(snapshot) {
        this.entries = [JSON.stringify(snapshot)];
        this.index = 0;
    }

    /** 記錄一次變動後的狀態；與目前相同就不記（避免無效的 undo 步驟） */
    record(snapshot) {
        const entry = JSON.stringify(snapshot);
        if (this.index >= 0 && this.entries[this.index] === entry) return false;

        this.entries = this.entries.slice(0, this.index + 1);
        this.entries.push(entry);
        if (this.entries.length > this.limit) this.entries.shift();
        this.index = this.entries.length - 1;
        return true;
    }

    canUndo() {
        return this.index > 0;
    }

    canRedo() {
        return this.index < this.entries.length - 1;
    }

    /** @returns {object|null} 要套用的快照（每次都是新物件） */
    undo() {
        if (!this.canUndo()) return null;
        this.index -= 1;
        return JSON.parse(this.entries[this.index]);
    }

    redo() {
        if (!this.canRedo()) return null;
        this.index += 1;
        return JSON.parse(this.entries[this.index]);
    }
}
