// 串行排队：前一个任务结束（成功或失败）后才开始下一个。审批按到达顺序一个一个问委托人（设计 §3.14）。

export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn, fn)
    this.tail = result.catch(() => undefined)
    return result
  }
}
