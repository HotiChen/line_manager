import { Env } from '../types';
import { jsonResponse, errorResponse, successResponse } from '../utils/response';
import { Storage } from '../utils/storage';

export async function handleProfileCheck(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const profile = await storage.get<any>(Storage.userKey(userId, 'profile'));

    return jsonResponse({
        exists: !!profile,
        profile: profile || {}
    });
}

export async function handleProfileRegister(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as any;
        const storage = new Storage(env);
        await storage.put(Storage.userKey(userId, 'profile'), body);
        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}

export async function handleTokenList(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const tokens = await storage.get<Record<string, string>>(Storage.userKey(userId, 'tokens')) || {};

    return jsonResponse(tokens);
}

export async function handleTokenRegister(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as { project: string; token: string };
        if (!body.project || !body.token) return errorResponse('Missing project or token');

        const storage = new Storage(env);
        const key = Storage.userKey(userId, 'tokens');
        const tokens = await storage.get<Record<string, string>>(key) || {};

        tokens[body.project] = body.token;
        await storage.put(key, tokens);

        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}

export async function handleTokenDelete(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as { project: string };
        if (!body.project) return errorResponse('Missing project name');

        const storage = new Storage(env);
        const key = Storage.userKey(userId, 'tokens');
        const tokens = await storage.get<Record<string, string>>(key) || {};

        delete tokens[body.project];
        await storage.put(key, tokens);

        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}
