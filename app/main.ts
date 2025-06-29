import * as net from "net";
import * as fs from "fs";
import * as path from 'path';
let configDir: string = "";
let configDbFilename: string = "";
let replicaOfHost : string | null = null;
let replicaOfPort :number | null = null;
let listeningPort  : number = 6379;
let masterSocket : net.Socket | null = null;
let handshakeStep: number = 0;
let replconfOkCount: number = 0;
let masterReplid: string = generateRandomHex(40);
let masterReplOffset: number = 0;
let replicaReadBuffer: Buffer = Buffer.alloc(0);
const connectedReplicas: net.Socket[] = [];
for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === '--dir' && i + 1 < process.argv.length) {
        configDir = process.argv[i + 1];
    } else if (process.argv[i] === '--dbfilename' && i + 1 < process.argv.length) {
        configDbFilename = process.argv[i + 1];
    } else if (process.argv[i]=== '--replicaof' && i + 2 < process.argv.length ) {
        replicaOfHost = process.argv[i+1];
        replicaOfPort = parseInt(process.argv[i+2], 10);
        i+=2;
    } else if (process.argv[i] === '--port' && i + 1 < process.argv.length) {
        listeningPort = parseInt(process.argv[i + 1], 10);
        i++;
    }
}
function generateRandomHex(length: number): string {
    let result = '';
    const characters = '0123456789abcdef';
    for (let i = 0; i < length; i++) {
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}
function readLength(buffer: Buffer, offset: number): { length: number; newOffset: number; isInteger?: boolean; integerValue?: number } {
    const firstByte = buffer.readUInt8(offset);
    let initialOffset = offset;
    offset++;
    const twoMsb = (firstByte & 0xC0) >> 6;
    if (twoMsb === 0b00) {
        return { length: firstByte & 0x3F, newOffset: offset };
    } else if (twoMsb === 0b01) {
        const nextByte = buffer.readUInt8(offset);
        offset++;
        const length = ((firstByte & 0x3F) << 8) | nextByte;
        return { length: length, newOffset: offset };
    } else if (twoMsb === 0b10) {
        const length = buffer.readUInt32BE(offset);
        offset += 4;
        return { length: length, newOffset: offset };
    } else {
        const encodingType = firstByte & 0x3F;
        if (encodingType === 0) {
            const value = buffer.readInt8(offset);
            offset += 1;
            return { length: -1, newOffset: offset, isInteger: true, integerValue: value };
        } else if (encodingType === 1) {
            const value = buffer.readInt16LE(offset);
            offset += 2;
            return { length: -1, newOffset: offset, isInteger: true, integerValue: value };
        } else if (encodingType === 2) {
            const value = buffer.readInt32LE(offset);
            offset += 4;
            return { length: -1, newOffset: offset, isInteger: true, integerValue: value };
        } else if (encodingType === 3) {
            console.warn(`[readLength] Encountered LZF compressed string encoding (0xC3) at offset ${initialOffset}. Not supported for direct value parsing.`);
            return { length: -1, newOffset: offset };
        } else {
            console.error(`[readLength] Unknown or unhandled special encoding type (0b11xxxx): 0x${firstByte.toString(16)} at offset ${initialOffset}.`);
            return { length: -1, newOffset: offset };
        }
    }
}
const rdbFilePath = path.join(configDir, configDbFilename);
console.log("Attempting to read RDB from:", rdbFilePath);
let rdbBuffer: Buffer;
try {
    rdbBuffer = fs.readFileSync(rdbFilePath);
    console.log("RDB file loaded successfully. Size:", rdbBuffer.length, "bytes.");
    const magicString = rdbBuffer.toString('ascii', 0, 5);
    const versionString = rdbBuffer.toString('ascii', 5, 9);
    console.log("Parsed RDB Magic String:", magicString);
    console.log("Parsed RDB Version String:", versionString);
    if (magicString !== 'REDIS') {
        console.error("Error: RDB magic string is incorrect!");
    }
} catch (error) {
    console.error(`Error reading RDB file from ${rdbFilePath}:`, error);
    process.exit(1);
}
const store = new Map<string, { value: string; expiresAt: number | null }>();
let currentOffset = 9;
let expiresAtMs: number | null = null;
if (typeof rdbBuffer !== 'undefined' && rdbBuffer.length > currentOffset) {
    while (currentOffset < rdbBuffer.length) {
        const opcode = rdbBuffer.readUInt8(currentOffset);
        if (opcode === 0xFF) {
            currentOffset++;
            currentOffset = rdbBuffer.length;
            console.log("Found OPCODE_EOF!");
            break;
        } else if (opcode === 0xFE) {
            currentOffset++;
            const dbNumber = rdbBuffer.readUInt8(currentOffset);
            currentOffset++;
            console.log(`Found SELECTDB opcode. Database number: ${dbNumber}`);
            expiresAtMs = null;
        } else if (opcode === 0xFC) {
            currentOffset++;
            expiresAtMs = Number(rdbBuffer.readBigUInt64LE(currentOffset));
            currentOffset += 8;
            console.log(`Found EXPIRETIME_MS. Expiry Timestamp: ${expiresAtMs} ms`);
        } else if (opcode === 0xFB) {
            currentOffset++;
            const dbSizeResult = readLength(rdbBuffer, currentOffset);
            currentOffset = dbSizeResult.newOffset;
            const expirySizeResult = readLength(rdbBuffer, currentOffset);
            currentOffset = expirySizeResult.newOffset;
            console.log(`Found RESIZEDB opcode. DB size: ${dbSizeResult.length}, Expiry size: ${expirySizeResult.length}`);
        } else if (opcode === 0xFA) {
            currentOffset++;
            const auxKeyLenResult = readLength(rdbBuffer, currentOffset);
            const auxKeyLen = auxKeyLenResult.length;
            currentOffset = auxKeyLenResult.newOffset;
            const auxKey = rdbBuffer.toString('utf8', currentOffset, currentOffset + auxKeyLen);
            currentOffset += auxKeyLen;
            const auxValueResult = readLength(rdbBuffer, currentOffset);
            let auxValue: string | number | undefined;
            if (auxValueResult.isInteger) {
                auxValue = auxValueResult.integerValue!;
                currentOffset = auxValueResult.newOffset;
            } else if (auxValueResult.length !== -1) {
                const auxValueLen = auxValueResult.length;
                currentOffset = auxValueResult.newOffset;
                auxValue = rdbBuffer.toString('utf8', currentOffset, currentOffset + auxValueLen);
                currentOffset += auxValueLen;
            } else {
                console.warn(`[RDB Parser] Unhandled aux value encoding for key '${auxKey}': 0x${rdbBuffer.readUInt8(auxValueResult.newOffset - 1).toString(16)} at offset ${auxValueResult.newOffset - 1}.`);
                auxValue = `UNHANDLED_ENC_0x${rdbBuffer.readUInt8(auxValueResult.newOffset - 1).toString(16)}`;
                currentOffset = auxValueResult.newOffset;
            }
            console.log(`Skipped Auxiliary Field: ${auxKey} = ${auxValue}`);
        }
        else if (opcode === 0x00) {
            currentOffset++;
            const keyLengthResult = readLength(rdbBuffer, currentOffset);
            const keyLength = keyLengthResult.length;
            currentOffset = keyLengthResult.newOffset;
            const key = rdbBuffer.toString('utf8', currentOffset, currentOffset + keyLength);
            currentOffset += keyLength;
            console.log(`Parsed Key: ${key}`);
            const valueLengthResult = readLength(rdbBuffer, currentOffset);
            const valueLength = valueLengthResult.length;
            currentOffset = valueLengthResult.newOffset;
            const value = rdbBuffer.toString('utf8', currentOffset, currentOffset + valueLength);
            currentOffset += valueLength;
            console.log(`Parsed Value: ${value}`);
            let finalExpiresAt: number | null = null;
            if (expiresAtMs !== null) {
                finalExpiresAt = (expiresAtMs > Date.now()) ? expiresAtMs : Date.now() - 1;
            }
            store.set(key, { value: value, expiresAt: finalExpiresAt });
            expiresAtMs = null;
        }
        else {
            const problemByte = rdbBuffer.readUInt8(currentOffset);
            console.warn(`[RDB Parser] Encountered unhandled RDB opcode byte 0x${problemByte.toString(16)} at offset ${currentOffset}. Advancing 1 byte.`);
            currentOffset++;
        }
    }
} else {
    console.warn("RDB buffer is undefined or empty after header, skipping RDB parsing loop.");
}
if (typeof rdbBuffer !== 'undefined') {
    if (currentOffset < rdbBuffer.length) {
        console.warn(`RDB parsing loop finished prematurely. Current offset: ${currentOffset}, Buffer length: ${rdbBuffer.length}. Next byte (if any): 0x${rdbBuffer.readUInt8(currentOffset).toString(16)}`);
    }
}
const server: net.Server = net.createServer((connection: net.Socket) => {
    if (replicaOfHost === null) {
        connectedReplicas.push(connection);
        console.log(`New replica connected. Total replicas: ${connectedReplicas.length}`);
    }
    connection.on('data', (data: Buffer) => {
        console.log('received:', JSON.stringify(data.toString()));
        let recieve: string[] = data.toString().split('\r\n');
        const command = recieve[2]?.toUpperCase();
        const subcommand = recieve[4]?.toLowerCase();
        switch (command) {
            case 'INFO':
                if (subcommand === 'replication') {
                    let infoContent: string;
                    if (replicaOfHost !== null && replicaOfPort !== null) {
                        infoContent = `# Replication\r\n` +
                                      `role:replica\r\n` +
                                      `master_host:${replicaOfHost}\r\n` +
                                      `master_port:${replicaOfPort}\r\n` +
                                      `master_link_status:up\r\n` +
                                      `master_replid:${masterReplid}\r\n` +
                                      `master_repl_offset:${masterReplOffset}`;
                    } else {
                        infoContent = `# Replication\r\n` +
                                      `role:master\r\n` +
                                      `master_replid:${masterReplid}\r\n` +
                                      `master_repl_offset:${masterReplOffset}`;
                    }
                    connection.write(`$${infoContent.length}\r\n${infoContent}\r\n`);
                } else {
                    connection.write('$-1\r\n');
                }
                break;
            case 'PING':
                if (recieve[0] === '*1' && recieve.length === 4) {
                    connection.write('+PONG\r\n');
                } else {
                    connection.write('-ERR wrong number of arguments for \'ping\' command\r\n');
                }
                break;
            case 'ECHO':
                if (recieve[0] === '*2' && recieve.length === 5) {
                    connection.write(`$${recieve[4].length}\r\n${recieve[4]}\r\n`);
                } else {
                    connection.write('-ERR wrong number of arguments for \'echo\' command\r\n');
                }
                break;
            case 'SET':
                if (recieve[0] === '*3' || recieve[0] === '*5' || recieve[0] === '*7') {
                    const key = recieve[4];
                    const value = recieve[6];
                    let expiresAt: number | null = null;
                    if (recieve.length > 7) {
                        const option = recieve[8];
                        const durationStr = recieve[10];
                        if (option?.toLowerCase() === 'ex') {
                            const seconds = parseInt(durationStr, 10);
                            if (!isNaN(seconds)) {
                                expiresAt = Date.now() + (seconds * 1000);
                            } else {
                                connection.write('-ERR value is not an integer or out of range\r\n');
                                break;
                            }
                        } else if (option?.toLowerCase() === 'px') {
                            const milliseconds = parseInt(durationStr, 10);
                            if (!isNaN(milliseconds)) {
                                expiresAt = Date.now() + milliseconds;
                            }
                            else {
                                connection.write('-ERR value is not an integer or out of range\r\n');
                                break;
                            }
                        } else {
                            connection.write('-ERR syntax error\r\n');
                            break;
                        }
                    }
                    store.set(key, { value, expiresAt });
                    connection.write('+OK\r\n');
                } else {
                    connection.write('-ERR wrong number of arguments for \'set\' command\r\n');
                }
                break;
            case 'GET':
                if (recieve[0] === '*2' && recieve.length === 5) {
                    const keyToGet = recieve[4];
                    const storedObject = store.get(keyToGet);
                    if (storedObject !== undefined) {
                        if (storedObject.expiresAt !== null && Date.now() >= storedObject.expiresAt) {
                            store.delete(keyToGet);
                            connection.write('$-1\r\n');
                        } else {
                            const actualValue = storedObject.value;
                            connection.write(`$${actualValue.length}\r\n${actualValue}\r\n`);
                        }
                    } else {
                        connection.write('$-1\r\n');
                    }
                } else {
                    connection.write('-ERR wrong number of arguments for \'get\' command\r\n');
                }
                break;
            case 'CONFIG':
                if (recieve.length === 7 && recieve[4]?.toUpperCase() === 'GET') {
                    const paramName = recieve[6];
                    let paramValue: string = '';
                    if (paramName === 'dir') {
                        paramValue = configDir;
                    } else if (paramName === 'dbfilename') {
                        paramValue = configDbFilename;
                    } else {
                        connection.write(`-ERR Unsupported CONFIG GET parameter: '${paramName}'\r\n`);
                        break;
                    }
                    const response = `*2\r\n` +
                                     `$${paramName.length}\r\n${paramName}\r\n` +
                                     `$${paramValue.length}\r\n${paramValue}\r\n`;
                    connection.write(response);
                } else {
                    connection.write('-ERR CONFIG subcommand not supported or wrong number of arguments\r\n');
                }
                break;
            case 'REPLCONF':
                if (recieve[0] === '*3' || recieve[0] === '*5') {
                    const option = recieve[4];
                    const value = recieve[6];
                    console.log(`Master received REPLCONF: ${option} ${value}`);
                    connection.write('+OK\r\n');
                } else {
                    connection.write('-ERR wrong number of arguments for \'replconf\' command\r\n');
                }
                break;
            case 'PSYNC':
                if (replicaOfHost === null && recieve[0] === '*3' && recieve.length === 8) {
                    const replid = recieve[4];
                    const offset = parseInt(recieve[6], 10);
                    console.log(`Master received PSYNC from replica: replid=${replid}, offset=${offset}`);
                    if (replid === '?' && offset === -1) {
                        const fullResyncResponse = `+FULLRESYNC ${masterReplid} ${masterReplOffset}\r\n`;
                        connection.write(fullResyncResponse);
                        const emptyRdbHex = '524544495330303131fa0972656469732d76657205382e312e32fa0a72656469732d62697473c040fa056374696d65c2b0c39f64fa08757365642d6d656dc211e401fa08616f662d62617365c000fe00fb0300ee00e6c0f204ff';
                        const emptyRdbBuffer = Buffer.from(emptyRdbHex, 'hex');
                        connection.write(emptyRdbBuffer);
                        console.log(`Master sent FULLRESYNC and empty RDB file (size: ${emptyRdbBuffer.length} bytes).`);
                    } else {
                        connection.write('-ERR PSYNC with unknown replid or invalid offset not supported\r\n');
                    }
                } else {
                    connection.write('-ERR wrong number of arguments for \'psync\' command or not a master\r\n');
                }
                break;
            default:
                connection.write(`-ERR unknown command '${command}'\r\n`);
                break;
        }
    });
    connection.on('close', () => {
        console.log('Client disconnected');
        if (replicaOfHost === null) {
            const index = connectedReplicas.indexOf(connection);
            if (index > -1) {
                connectedReplicas.splice(index, 1);
                console.log(`Replica disconnected. Total replicas: ${connectedReplicas.length}`);
            }
        }
    });
    connection.on('error', (err: Error) => {
        console.error('Socket error:', err);
    });
});
server.listen(listeningPort, "127.0.0.1", () => {
    console.log(`Redis server is listening on 127.0.0.1:${listeningPort}`);
    if (replicaOfHost !== null && replicaOfPort !== null) {
        console.log(`Attempting to connect to master at ${replicaOfHost}:${replicaOfPort}`);
        masterSocket = net.createConnection(replicaOfPort, replicaOfHost, () => {
            console.log(`Connected to master at ${replicaOfHost}:${replicaOfPort}`);
            const pingCommand = '*1\r\n$4\r\nPING\r\n';
            masterSocket?.write(pingCommand);
            console.log('Sent PING to master.');
            handshakeStep = 1;
        });
        masterSocket.on('data', (data: Buffer) => {
            replicaReadBuffer = Buffer.concat([replicaReadBuffer, data]);
            let responseEndIndex: number;
            while ((responseEndIndex = replicaReadBuffer.indexOf('\r\n')) !== -1) {
                const fullResponseBuffer = replicaReadBuffer.slice(0, responseEndIndex + 2);
                replicaReadBuffer = replicaReadBuffer.slice(responseEndIndex + 2);
                const responseString = fullResponseBuffer.toString().trim();
                console.log(`Received processed from master: ${responseString.slice(0, 50)}... (truncated)`);
                if (handshakeStep === 1 && responseString === '+PONG') {
                    console.log('Master responded with PONG. Handshake Step 1 complete. Sending REPLCONF commands...');
                    const replconfPortCommand = `*3\r\n$8\r\nREPLCONF\r\n$14\r\nlistening-port\r\n$${listeningPort.toString().length}\r\n${listeningPort}\r\n`;
                    masterSocket?.write(replconfPortCommand);
                    const replconfCapaCommand = `*3\r\n$8\r\nREPLCONF\r\n$4\r\ncapa\r\n$6\r\npsync2\r\n`;
                    masterSocket?.write(replconfCapaCommand);
                    handshakeStep = 2;
                } else if (handshakeStep === 2 && responseString === '+OK') {
                    replconfOkCount++;
                    console.log(`Received +OK for REPLCONF. Handshake Step 2 continuing... (${replconfOkCount}/2)`);
                    if (replconfOkCount === 2) {
                        console.log('All REPLCONF commands acknowledged. Sending PSYNC command...');
                        const psyncCommand = '*3\r\n$5\r\nPSYNC\r\n$1\r\n?\r\n$2\r\n-1\r\n';
                        masterSocket?.write(psyncCommand);
                        handshakeStep = 3;
                        replconfOkCount = 0;
                    }
                } else if (handshakeStep === 3 && responseString.startsWith('+FULLRESYNC')) {
                    const parts = responseString.split(' ');
                    if (parts.length >= 3) {
                        masterReplid = parts[1];
                        masterReplOffset = parseInt(parts[2], 10);
                        console.log(`Received FULLRESYNC from master. Master ID: ${masterReplid}, Offset: ${masterReplOffset}.`);
                        console.log('Master is sending RDB file. Preparing to receive...');
                        handshakeStep = 4;
                    } else {
                        console.warn(`Unexpected FULLRESYNC format: ${responseString}`);
                    }
                }
                else {
                    if (handshakeStep !== 4) {
                        console.warn(`Unexpected response from master: ${responseString}`);
                    }
                }
            }
            if (handshakeStep === 4 && replicaReadBuffer.length > 0) {
                console.log(`RDB data received. Total RDB bytes in buffer: ${replicaReadBuffer.length}`);
                replicaReadBuffer = Buffer.alloc(0);
            }
        });
        masterSocket.on('error', (err: Error) => {
            console.error('Master socket error:', err);
        });
        masterSocket.on('close', () => {
            console.log('Connection to master closed.');
            masterSocket = null;
        });
    }
});