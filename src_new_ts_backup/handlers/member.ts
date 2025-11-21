import { Env } from '../types';
import { jsonResponse, errorResponse, successResponse } from '../utils/response';
import { Storage } from '../utils/storage';

export async function handleMemberList(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    const storage = new Storage(env);
    const members = await storage.get<any[]>(Storage.userKey(userId, 'members')) || [];

    return successResponse(members);
}

export async function handleMemberSave(request: Request, env: Env): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    if (!userId) return errorResponse('Missing X-User-Id header', 401);

    try {
        const body = await request.json() as any;
        if (!body.memberId) return errorResponse('Missing memberId');

        const storage = new Storage(env);
        const key = Storage.userKey(userId, 'members');
        let members = await storage.get<any[]>(key) || [];

        const index = members.findIndex(m => m.memberId === body.memberId);
        if (index !== -1) {
            members[index] = body;
        } else {
            members.push(body);
        }

        await storage.put(key, members);
        return successResponse();
    } catch (e) {
        return errorResponse('Invalid request body');
    }
}
