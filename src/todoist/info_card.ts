import { DoistCard, SubmitAction, TextBlock } from "@doist/ui-extensions-core";

type Target = "project" | "task";

export const infoCard = (actionId: string, text: string): DoistCard => {
    const card = new DoistCard();

    card.addItem(
        TextBlock.from({
            text,
            wrap: true,
            size: "large",
        })
    );

    card.addAction(
        SubmitAction.from({
            id: actionId,
            title: "Close",
            style: "positive",
        })
    );

    return card;
};

export const retryInfoCard = (actionId: string, target: Target): DoistCard =>
    infoCard(actionId, `Make sure that the ${target} is synced and try again.`);

export const syncInfoCard = (actionId: string, target: Target): DoistCard =>
    infoCard(
        actionId,
        `
The ${target} is converted in the background.
It might take a few minutes, do not modify it in the meantime.
        `
    );
