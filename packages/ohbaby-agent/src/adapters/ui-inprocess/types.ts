import type { UiNotice } from "ohbaby-sdk";

export type NoticeDraft = Omit<UiNotice, "id" | "createdAt"> & {
  readonly createdAt?: string;
};
