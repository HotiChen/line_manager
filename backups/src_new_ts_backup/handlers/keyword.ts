import { Env } from '../types';
import { jsonResponse, errorResponse, successResponse } from '../utils/response';
import { Storage } from '../utils/storage';

export async function handleKeywordList(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const keywords = await storage.get<any[]>(Storage.userKey(userId, 'keywords')) || [];

    return successResponse(keywords);
}

export async function handleKeywordSave(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as any;
        if (!body.keyword) return errorResponse('Missing keyword');

        const storage = new Storage(env);
        const key = Storage.userKey(userId, 'keywords');
        let keywords = await storage.get<any[]>(key) || [];

        // Remove existing if updating
        keywords = keywords.filter(k => k.keyword !== body.keyword);
        keywords.push(body);

        await storage.put(key, keywords);
        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}

export async function handleKeywordDelete(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as { keyword: string };
        if (!body.keyword) return errorResponse('Missing keyword');

        const storage = new Storage(env);
        const key = Storage.userKey(userId, 'keywords');
        let keywords = await storage.get<any[]>(key) || [];

        keywords = keywords.filter(k => k.keyword !== body.keyword);
        await storage.put(key, keywords);

        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}

export async function handleKeywordStats(request: Request, env: Env): Promise<Response> {
    // Mock stats for now
    return jsonResponse({
        total: 0,
        active: 0
    });
}
