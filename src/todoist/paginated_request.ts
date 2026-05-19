import { TodoistApi } from "@doist/todoist-sdk";

const TODOIST_PAGINATION_LIMIT = 200;

type Cursor = { cursor?: string };
type Limit = { limit: number };

const paginatedRequest = async <P, R>(
    api: TodoistApi,
    apiMethod: (arg: P & Cursor & Limit) => Promise<{
        results: R[];
        nextCursor: string | null;
    }>,
    arg: P & Cursor
): Promise<R[]> => {
    const boundMethod = apiMethod.bind(api);
    const paginatedArg = { ...arg, limit: TODOIST_PAGINATION_LIMIT };

    const result: R[] = [];
    while (true) {
        const response = await boundMethod(paginatedArg);
        result.push(...response.results);

        if (response.nextCursor === null) break;
        paginatedArg.cursor = response.nextCursor;
    }
    return result;
};

export default paginatedRequest;
