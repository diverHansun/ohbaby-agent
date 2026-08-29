export class StartupNoticeBuffer {
  private readonly notices: string[] = [];

  push(message: string): void {
    this.notices.push(message);
  }

  takeAll(): readonly string[] {
    return this.notices.splice(0);
  }
}
