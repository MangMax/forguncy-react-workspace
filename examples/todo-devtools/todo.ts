export interface Task {
  readonly id: string;
  readonly title: string;
  readonly done: boolean;
}

export type Commands = {
  SaveTask: [payload: Pick<Task, "id" | "done">];
};
