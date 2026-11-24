import { TREE_PROJECTION, type SpineTree } from "./tree.js";
type TranslationKey = keyof typeof worktreeText.en;
type Translate = (key: TranslationKey, values?: {
    count: number;
}) => string;
/** The dock seat's props the entry reads. */
export interface SpineDockProps {
    useProjection(key: typeof TREE_PROJECTION): SpineTree | null | undefined;
    t: Translate;
}
export declare const worktreeText: {
    zh: {
        title: string;
        current: string;
        parallel: string;
        complete: string;
        error: string;
        aborted: string;
        task: string;
        currentTask: string;
        completedTask: string;
        previousTask: string;
        parallelOne: string;
        parallelMany: string;
        earlierOne: string;
        earlierMany: string;
    };
    en: {
        title: string;
        current: string;
        parallel: string;
        complete: string;
        error: string;
        aborted: string;
        task: string;
        currentTask: string;
        completedTask: string;
        previousTask: string;
        parallelOne: string;
        parallelMany: string;
        earlierOne: string;
        earlierMany: string;
    };
};
/** Reads the session projection and keeps disclosure state in the native element. */
export declare function SpineDock({ useProjection, t }: SpineDockProps): unknown;
export {};
//# sourceMappingURL=worktree.d.ts.map