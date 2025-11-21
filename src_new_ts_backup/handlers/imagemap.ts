import { Env } from '../types';
import { jsonResponse, errorResponse, successResponse } from '../utils/response';
import { Storage } from '../utils/storage';

export async function handleImagemapSave(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as { imagemaps: any[] };
        if (!body.imagemaps || !Array.isArray(body.imagemaps)) return errorResponse('Missing imagemaps array');

        const storage = new Storage(env);
        await storage.put(Storage.userKey(userId, 'imagemaps'), body.imagemaps);

        return successResponse({ message: 'ImageMaps saved successfully' });
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}

export async function handleImagemapList(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const imagemaps = await storage.get<any[]>(Storage.userKey(userId, 'imagemaps')) || [];

    return successResponse(imagemaps);
}
