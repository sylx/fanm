// 制作ジョブ。一作品の試行を一つのジョブとし、状態を var/jobs に保存する。
// コンテナやホストが止まっても、保存された状態から再開する。
//
//     planned → generated → checked → (repairing → checked)* → accepted | rejected
//     accepted → published

export type JobState =
    | "planned"
    | "generated"
    | "checked"
    | "repairing"
    | "accepted"
    | "rejected"
    | "published";

export interface Job {
    /** 再試行で同じ作品を重複公開しないための識別子。 */
    readonly id: string;
    state: JobState;
    repairs: number;
    readonly createdAt: string;
    updatedAt: string;
    rejectReason?: string;
}

/** 修正回数の初期上限。 */
export const MAX_REPAIRS = 2;
