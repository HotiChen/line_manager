import * as config from '../env/config.js';

const state = {
    userId: null,
    currentProject: null
};

export function setUserId(id) {
    state.userId = id;
    if (config.debug) console.log('[State] User ID set to:', id);
}

export function getUserId() {
    return state.userId;
}

export function setCurrentProject(project) {
    state.currentProject = project;
    if (config.debug) console.log('[State] Current Project set to:', project);
}

export function getCurrentProject() {
    return state.currentProject;
}

export const apiBase = config.apiBase;
export const debug = config.debug;
