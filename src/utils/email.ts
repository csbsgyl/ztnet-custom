export const normalizeEmail = (email: string) => email.trim().toLowerCase();

export const hasUppercaseEmail = (email: string) => email !== email.toLowerCase();
