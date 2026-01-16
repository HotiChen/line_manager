/**
 * Logger Utility
 */
export const info = (tag, message, data = '') => {
    console.log(`[${tag}] INFO: ${message}`, data);
};

export const warn = (tag, message, data = '') => {
    console.warn(`[${tag}] WARN: ${message}`, data);
};

export const error = (tag, message, err = '') => {
    console.error(`[${tag}] ERROR: ${message}`, err);
};

export const debug = (tag, message, data = '') => {
    console.log(`[${tag}] DEBUG: ${message}`, data);
};
