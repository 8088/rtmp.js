/*
 * Copyright 2015 Mozilla Foundation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

module RtmpJs.Node {
  declare function require(name: string): any;

  declare var Buffer;

  var net = require('net');
  var DEFAULT_RTMP_PORT = 1935;
  var COMBINE_RTMPT_DATA = false;

  export class RtmpTransport extends BaseTransport {
    host: string;
    port: number;

    constructor(connectionSettings) {
      super();

      if (typeof connectionSettings === 'string') {
        connectionSettings = { host: connectionSettings };
      }

      this.host = connectionSettings.host || 'localhost';
      this.port = connectionSettings.port || DEFAULT_RTMP_PORT;
    }

    connect(properties, args?) {
      var channel = this._initChannel(properties, args);

      var writeQueue = [];
      var writeAllowed = true;

      function sendQueued() {
        if (writeQueue.length === 0 || !writeAllowed) {
          return;
        }
        var buf = writeQueue.shift();
        release || console.log('Bytes written: ' + buf.length);
        writeAllowed = false;
        client.write(buf, 'hex', function () {
          writeAllowed = true;
          sendQueued();
        });
      }

      var client = net.createConnection({port: this.port, host: this.host},
        function () { //'connect' listener
          channel.ondata = function (data) {
            var buf = new Buffer(data);
            writeQueue.push(buf);
            sendQueued();
          };
          channel.onclose = function () {
            client.destroy();
          };
          channel.start();
        });
      client.setNoDelay();
      client.on('data', function (data) {
        release || console.log('Bytes read: ' + (data.length >> 1));
        var buf = new Buffer(data, 'hex');
        channel.push(buf);
      });
      client.on('close', function (obj) {
        channel.stop(obj.has_error);
      });
    }
  }

  var http = require('http');
  var emptyPostData = new Uint8Array([0]);

  export class RtmptTransport extends BaseTransport {
    host: string;
    protocol: string;
    port: number;
    stopped: boolean;
    sessionId: string;
    requestId: number;
    data: Uint8Array[];

    constructor(connectionSettings) {
      super();

      this.host = connectionSettings.host || 'localhost';
      this.protocol = connectionSettings.ssl ? 'https:' : 'http:';
      this.port = connectionSettings.port || (connectionSettings.ssl ? 443 : 80);

      this.stopped = false;
      this.sessionId = null;
      this.requestId = 0;
      this.data = [];
    }

    private _post(path, data, onload) {
      data || (data = emptyPostData);

      var options = {
        hostname: this.host,
        port: this.port,
        protocol: this.protocol,
        path: path,
        method: 'POST',
        headers: {
          'content-length': data.length,
          'content-type': 'application/x-fcs',
          'connection': 'keep-alive'
        }
      };

      var req = http.request(options, function (res) {
        res.setEncoding('hex');
        var buffer = '';
        res.on('data', function (chunk) {
          buffer += chunk;
        });
        res.on('end', function () {
          var decoded = new Buffer(buffer, 'hex');
          onload(decoded, res.statusCode);
        });
      });
      req.end(new Buffer(data));
    }

    connect(properties, args?) {
      var channel = this._initChannel(properties, args);
      channel.ondata = function (data) {
        release || console.log('Bytes written: ' + data.length);
        this.data.push(Array.prototype.slice.call(data, 0));
      }.bind(this);
      channel.onclose = function () {
        this.stopped = true;
      }.bind(this);


      this._post('/fcs/ident2', null, function (data, status) {
        if (status !== 404) {
          throw new Error('Unexpected response: ' + status);
        }

        this._post('/open/1', null, function (data, status) {
          this.sessionId = String.fromCharCode.apply(null, data).slice(0, -1); // - '\n'
          console.log('session id: ' + this.sessionId);

          this.tick();
          channel.start();
        }.bind(this));
      }.bind(this));
    }

    tick() {
      var continueSend = function (data, status) {
        if (status !== 200) {
          throw new Error('Invalid HTTP status: ' + status);
        }

        var idle = data[0];
        if (data.length > 1) {
          var buf = new Uint8Array(data.length - 1);
          for (var i = 1; i < data.length; i++) {
            buf[i - 1] = data[i];
          }
          this.channel.push(buf);
        }
        setTimeout(this.tick.bind(this), idle * 16);
      }.bind(this);

      if (this.stopped) {
        this._post('/close/2', null, function () {
          // do nothing
        });
        return;
      }

      if (this.data.length > 0) {
        var data;
        if (COMBINE_RTMPT_DATA) {
          var length = 0;
          this.data.forEach(function (i) {
            length += i.length;
          });
          var pos = 0;
          data = new Uint8Array(length);
          this.data.forEach(function (i) {
            data.set(i, pos);
            pos += i.length;
          });
          this.data.length = 0;
        } else {
          data = this.data.shift();
        }
        this._post('/send/' + this.sessionId + '/' + (this.requestId++),
          data, continueSend);
      } else {
        this._post('/idle/' + this.sessionId + '/' + (this.requestId++),
          null, continueSend);
      }
    }
  }
}

declare var exports;
exports.RtmpJs = RtmpJs;
