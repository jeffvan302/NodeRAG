export interface ViewerResearchPageAction {
  readonly savedPages: ReadonlySet<number>;
  readonly busyPage: number | null;
  readonly toggle: (pageNumber: number) => void;
}

export interface ViewerResearchAction {
  readonly researchName: string | null;
  readonly saved: boolean;
  readonly busy: boolean;
  readonly feedback?: {
    readonly kind: 'success' | 'danger';
    readonly text: string;
  };
  readonly toggle: () => void;
  readonly page?: ViewerResearchPageAction;
}
