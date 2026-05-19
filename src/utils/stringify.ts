export const errorToString = (error: unknown): string => {
    if (error instanceof Error) return error.stack ?? error.message;
    if (typeof error === "string") return error;
    return JSON.stringify(error);
};
