// SPDX-License-Identifier: Apache-2.0
import { DatabaseSync } from 'node:sqlite';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { noLinks } from './nnd-payload-contract-files.js';
import { installError } from './nnd-install-storage.js';

const LIMIT = 48 * 1024 * 1024;
const SCHEMA = 'CREATE TABLE initialization (id INTEGER PRIMARY KEY CHECK(id=1), intent TEXT NOT NULL)';
const databasePath = root => join(root, 'initialization.sqlite');
async function regular(path, optional = false) {
 let info;
 try { info = await lstat(path); } catch(error) { if(optional && error.code==='ENOENT') return false;throw installError(); }
 if(!info.isFile()||info.isSymbolicLink()||info.nlink!==1||info.size>96*1024*1024)throw installError();
 await noLinks(path);return true;
}
async function openDatabase(root, writable) {
 const path=databasePath(root);
 if(!await regular(path,true)&&!writable)return null;
 for(const suffix of ['-journal','-wal','-shm'])await regular(path+suffix,true);
 let database;
 try {
  database=new DatabaseSync(path,{readOnly:!writable});
  database.exec('PRAGMA busy_timeout=0;');
  const schema=database.prepare("SELECT name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' LIMIT 2").all();
  if(schema.length>1||schema.length===1&&(schema[0].name!=='initialization'||schema[0].sql!==SCHEMA))throw installError();
  if(!schema.length) {
   if(!writable){database.close();return null;}
   database.exec(SCHEMA);
  }
  if(writable)database.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA max_page_count=24576;');
  return database;
 } catch(error) {database?.close();throw installError();}
}
function readRow(database) {
 const bounds=database.prepare('SELECT id, length(CAST(intent AS BLOB)) AS bytes FROM initialization LIMIT 2').all();
 if(!bounds.length)return null;
 if(bounds.length!==1||bounds[0].id!==1||bounds[0].bytes>LIMIT)throw installError();
 return database.prepare('SELECT intent FROM initialization WHERE id=1').get().intent;
}
export async function hasInstallInitialization(dataRoot) {
 const database=await openDatabase(join(dataRoot,'runtime/nnd/install-slots'),false);
 if(!database)return false;
 try {return readRow(database)!==null;}finally{database.close();}
}
export async function withInstallInitialization(root, callback) {
 const database=await openDatabase(root,true);
 try {
  return await callback({read:()=>readRow(database),
   write:bytes=>{
    if(Buffer.byteLength(bytes)>LIMIT||readRow(database)!==null)throw installError();
    database.prepare('INSERT INTO initialization(id,intent) VALUES(1,?)').run(bytes);
   },
   clear:bytes=>{
    if(readRow(database)!==bytes)throw installError();
    database.prepare('DELETE FROM initialization WHERE id=1 AND intent=?').run(bytes);
   }});
 }finally{database.close();}
}
