import { Transform } from 'node:stream';

export class BoundedJSONTransform extends Transform {
  constructor(normalize, maximum) {
    super(); this.normalize = normalize;
    this.buffer = Buffer.allocUnsafe(maximum);
    this.length = 0;
    this.passthrough = false;
  }

  _transform(chunk, encoding, callback) {
    if (this.passthrough) this.push(chunk);
    else if (this.length + chunk.length > this.buffer.length) {
      if (this.length) this.push(this.buffer.subarray(0, this.length));
      this.buffer = null;
      this.passthrough = true;
      this.push(chunk);
    } else {
      chunk.copy(this.buffer, this.length);
      this.length += chunk.length;
    }
    callback();
  }

  _flush(callback) {
    if (!this.passthrough) {
      const bytes = this.buffer.subarray(0, this.length);
      this.push(this.normalize(bytes) ?? bytes);
    }
    callback();
  }
}

export class BoundedSSETransform extends Transform {
  constructor(normalize, maximum, { idleMs = 0, canPing = () => false } = {}) {
    super(); this.normalize = normalize;
    if (!Number.isSafeInteger(idleMs) || idleMs < 0 || idleMs > 2147483647) throw new TypeError('Invalid heartbeat interval.');
    if (idleMs > 0) {
      this.lastWrite = Date.now();
      this.pingTimer = setInterval(() => {
        if (!this.destroyed && !this.writableEnded && this.length === 0 && this.lineLength === 0 && !this.passthrough &&
          this.readableLength < this.readableHighWaterMark && canPing() && Date.now() - this.lastWrite >= idleMs) {
          this.push(Buffer.from('event: ping\ndata: {"type":"ping"}\n\n')); this.lastWrite = Date.now();
        }
      }, idleMs);
      this.pingTimer.unref();
    }
    this.buffer = Buffer.allocUnsafe(maximum);
    this.length = 0;
    this.lineLength = 0;
    this.lastByte = 0;
    this.passthrough = false;
  }

  append(chunk) {
    if (this.passthrough) this.push(chunk);
    else if (this.length + chunk.length > this.buffer.length) {
      if (this.length) this.push(Buffer.from(this.buffer.subarray(0, this.length)));
      this.length = 0;
      this.passthrough = true;
      this.push(chunk);
    } else {
      chunk.copy(this.buffer, this.length);
      this.length += chunk.length;
    }
  }

  _transform(chunk, encoding, callback) {
    let start = 0;
    for (let index = 0; index < chunk.length; index++) {
      const byte = chunk[index];
      const boundary = byte === 10 && (this.lineLength === 0 || (this.lineLength === 1 && this.lastByte === 13));
      this.lineLength = byte === 10 ? 0 : Math.min(this.lineLength + 1, 2);
      this.lastByte = byte;
      if (!boundary) continue;
      this.append(chunk.subarray(start, index + 1));
      if (!this.passthrough) this.push(this.normalize(Buffer.from(this.buffer.subarray(0, this.length))));
      this.length = 0;
      this.passthrough = false;
      start = index + 1;
    }
    if (start < chunk.length) this.append(chunk.subarray(start));
    this.lastWrite = Date.now();
    callback();
  }

  _destroy(error, callback) { clearInterval(this.pingTimer); callback(error); }

  _flush(callback) {
    clearInterval(this.pingTimer);
    if (this.length) this.push(Buffer.from(this.buffer.subarray(0, this.length)));
    callback();
  }
}
