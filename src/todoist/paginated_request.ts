import { TodoistApi } from "@doist/todoist-sdk";

interface PaginatedParameter {
    cursor?: string | null;
}

type PaginatedFunction<P, R> = (arg: P) => Promise<{
    results: R[];
    nextCursor: string | null;
}>;

const paginatedRequest = async <P, R>(
    api: TodoistApi,
    apiMethod: PaginatedFunction<P, R>,
    arg: NoInfer<P & PaginatedParameter>
): Promise<R[]> => {
    apiMethod = apiMethod.bind(api);

    const result: R[] = [];
    while (true) {
        const response = await apiMethod(arg);
        result.push(...response.results);

        if (response.nextCursor === null) break;
        arg.cursor = response.nextCursor;
    }
    return result;
};

export default paginatedRequest;
