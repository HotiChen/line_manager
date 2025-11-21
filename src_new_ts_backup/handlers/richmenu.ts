import { Env } from '../types';
import { jsonResponse, errorResponse, successResponse } from '../utils/response';
import { Storage } from '../utils/storage';

export async function handleRichmenuList(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const richmenus = await storage.get<any[]>(Storage.userKey(userId, 'richmenus')) || [];

    return jsonResponse({ richmenus });
}

export async function handleRichmenuDefault(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const defaultId = await storage.get<string>(Storage.userKey(userId, 'richmenu_default'));

    return jsonResponse({ richMenuId: defaultId });
}

export async function handleRichmenuSync(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as { richmenus: any[] };
        if (!body.richmenus || !Array.isArray(body.richmenus)) return errorResponse('Missing richmenus array');

        const storage = new Storage(env);
        await storage.put(Storage.userKey(userId, 'richmenus'), body.richmenus);

        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}
