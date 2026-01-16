import { Env } from '../types';
import { jsonResponse, errorResponse, successResponse } from '../utils/response';
import { Storage } from '../utils/storage';

export async function handleFlexSync(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as { flexs: any[] };
        if (!body.flexs || !Array.isArray(body.flexs)) return errorResponse('Missing flexs array');

        const storage = new Storage(env);
        await storage.put(Storage.userKey(userId, 'flexs'), body.flexs);

        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}

export async function handleFlexList(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const flexs = await storage.get<any[]>(Storage.userKey(userId, 'flexs')) || [];

    // The frontend expects a list of messages for "flex" type
    return successResponse(flexs);
}
