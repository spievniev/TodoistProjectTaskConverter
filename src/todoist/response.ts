export const successResponse = () => ({
    bridges: [{ bridgeActionType: "request.sync" }, { bridgeActionType: "finished" }],
});

export const errorResponse = (text: string) => ({
    bridges: [
        {
            bridgeActionType: "display.notification",
            notification: { type: "error", text },
        },
        { bridgeActionType: "finished" },
    ],
});
