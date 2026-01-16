import { Env } from '../types';
import { jsonResponse, errorResponse, successResponse } from '../utils/response';
import { Storage } from '../utils/storage';

export async function handleTagList(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const tags = await storage.get<string[]>(Storage.userKey(userId, 'tags')) || [];

    return successResponse(tags);
}

export async function handleTagSave(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as { name: string };
        if (!body.name) return errorResponse('Missing tag name');

        const storage = new Storage(env);
        const key = Storage.userKey(userId, 'tags');
        const tags = await storage.get<string[]>(key) || [];

        if (!tags.includes(body.name)) {
            tags.push(body.name);
            await storage.put(key, tags);
        }

        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}

export async function handleTagDelete(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as { names: string[] };
        if (!body.names || !Array.isArray(body.names)) return errorResponse('Missing tag names array');

        const storage = new Storage(env);
        const key = Storage.userKey(userId, 'tags');
        let tags = await storage.get<string[]>(key) || [];

        tags = tags.filter(t => !body.names.includes(t));
        await storage.put(key, tags);

        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}
