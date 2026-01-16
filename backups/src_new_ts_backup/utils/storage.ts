import { Env } from '../types';

export class Storage {
    private kv: KVNamespace;

    constructor(env: Env) {
        this.kv = env.DATA_STORE;
    }

    async get<T>(key: string): Promise<T | null> {
        const value = await this.kv.get(key, 'json');
        return value as T | null;
    }

    async put(key: string, value: any): Promise<void> {
        await this.kv.put(key, JSON.stringify(value));
    }

    async delete(key: string): Promise<void> {
        await this.kv.delete(key);
    }

    // Helper to get user-specific key
    static userKey(userId: string, key: string): string {
        return `user:${userId}:${key}`;
    }
}
