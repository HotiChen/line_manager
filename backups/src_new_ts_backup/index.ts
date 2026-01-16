import { Env } from './types';
import { Router } from './router';

import { handleTagList, handleTagSave, handleTagDelete } from './handlers/tag';
import { handleMemberList, handleMemberSave } from './handlers/member';
import { handleProfileCheck, handleProfileRegister, handleTokenList, handleTokenRegister, handleTokenDelete } from './handlers/profile';
import { handleKeywordList, handleKeywordSave, handleKeywordDelete, handleKeywordStats } from './handlers/keyword';
import { handleRichmenuList, handleRichmenuDefault, handleRichmenuSync } from './handlers/richmenu';
import { handleFlexList, handleFlexSync } from './handlers/flex';
import { handleImagemapList, handleImagemapSave } from './handlers/imagemap';

const router = new Router();

router.get('/tag/list', handleTagList);
router.post('/tag/save', handleTagSave);
router.post('/tag/delete', handleTagDelete);

router.get('/member/list-full', handleMemberList);
router.post('/member/save', handleMemberSave);

router.get('/profile/check', handleProfileCheck);
router.post('/profile/register', handleProfileRegister);
router.get('/token/list', handleTokenList);
router.post('/token/register', handleTokenRegister);
router.delete('/token/delete', handleTokenDelete);

router.get('/keyword/list', handleKeywordList);
router.post('/keyword/save', handleKeywordSave);
router.post('/keyword/delete', handleKeywordDelete);
router.get('/keyword/stats', handleKeywordStats);

router.get('/richmenu/list', handleRichmenuList);
router.get('/richmenu/default', handleRichmenuDefault);
router.post('/richmenu/sync', handleRichmenuSync);

router.get('/flex/list', handleFlexList);
router.post('/flex/sync', handleFlexSync);

router.get('/imagemap/list', handleImagemapList);
router.post('/imagemap/save', handleImagemapSave);

router.get('/health', async () => new Response(JSON.stringify({ status: 'ok' }), { headers: { 'Content-Type': 'application/json' } }));

export default {
    async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
        // CORS handling
        if (request.method === 'OPTIONS') {
            return new Response(null, {
                headers: {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
                    'Access-Control-Allow-Headers': 'Content-Type, X-User-Id',
                },
            });
        }

        try {
            const response = await router.resolve(request, env, ctx);

            // Add CORS headers to response
            const newHeaders = new Headers(response.headers);
            newHeaders.set('Access-Control-Allow-Origin', '*');
            return new Response(response.body, {
                status: response.status,
                statusText: response.statusText,
                headers: newHeaders,
            });
        } catch (err: any) {
            return new Response(JSON.stringify({ error: err.message }), {
                status: 500,
                headers: {
                    'Content-Type': 'application/json',
                    'Access-Control-Allow-Origin': '*',
                },
            });
        }
    },
};
