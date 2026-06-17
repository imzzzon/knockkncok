#!/usr/bin/env node

const chokidar = require('chokidar');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ignoredFiles = ['.git', '.DS_Store', 'node_modules', '.vscode', 'package.json', 'package-lock.json', 'auto-commit.js'];
const debounceTime = 3000; // 3초 대기
let debounceTimer = null;

// git 명령 실행 (셸로 직접 실행)
function runGit(command) {
  try {
    return execSync(`git ${command}`, { 
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8'
    });
  } catch (error) {
    throw new Error(error.message);
  }
}

// git lock 파일 정리
function cleanGitLock() {
  const lockFile = '.git/index.lock';
  let retries = 3;
  while (retries > 0 && fs.existsSync(lockFile)) {
    try {
      fs.unlinkSync(lockFile);
      break;
    } catch (e) {
      retries--;
      if (retries === 0) throw e;
    }
  }
}

// 무시할 파일 확인
function shouldIgnore(filePath) {
  return ignoredFiles.some(ignored => filePath.includes(ignored));
}

// 변경사항 요약 생성
function generateCommitMessage() {
  try {
    const statusOutput = runGit('status --porcelain');
    
    let added = 0, modified = 0, deleted = 0;
    const files = [];
    
    statusOutput.split('\n').forEach(line => {
      if (!line) return;
      const status = line.substring(0, 2);
      const filePath = line.substring(3);
      
      if (shouldIgnore(filePath)) return;
      
      if (status[0] === '?' || status === 'A ' || status === 'AM') added++;
      else if (status === 'M ' || status === 'MM') modified++;
      else if (status === ' D' || status === 'D ') deleted++;
      
      files.push({ status, path: filePath });
    });
    
    let message = '📝 자동 커밋: ';
    const changes = [];
    
    if (added > 0) changes.push(`추가 ${added}개`);
    if (modified > 0) changes.push(`수정 ${modified}개`);
    if (deleted > 0) changes.push(`삭제 ${deleted}개`);
    
    message += (changes.length > 0 ? changes.join(', ') : '변경사항 업데이트');
    
    // 구체적인 파일 목록
    if (files.length > 0) {
      message += '\n\n변경된 파일:\n';
      files.forEach(f => {
        const statusMap = { 'M ': '[수정]', 'A ': '[추가]', ' D': '[삭제]', '??': '[추가]' };
        const s = statusMap[f.status] || '[변경]';
        message += `${s} ${f.path}\n`;
      });
    }
    
    return message;
  } catch (error) {
    return '📝 자동 커밋: 변경사항 업데이트';
  }
}

// 자동 커밋 및 푸시
function autoCommitAndPush() {
  try {
    // lock 정리
    cleanGitLock();
    
    console.log('\n🔄 변경사항 감지됨, 처리 중...');
    
    // 모든 변경사항 먼저 add (stat 캐시 문제 해결)
    try {
      runGit('add -A');
    } catch (e) {
      // add 실패는 무시
    }
    
    // git status 확인
    const status = runGit('status --porcelain');
    const hasChanges = status.trim().length > 0;
    
    if (!hasChanges) {
      console.log('✨ 커밋할 변경사항이 없습니다.');
      return;
    }
    
    console.log('✅ 변경사항 감지됨');
    
    // 커밋 메시지 생성 및 커밋
    const commitMessage = generateCommitMessage();
    runGit(`commit -m "${commitMessage.split('\n')[0]}"`);
    console.log(`✅ 커밋 완료`);
    console.log(commitMessage);
    
    // 푸시
    runGit('push origin main');
    console.log('✅ 푸시 완료!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    
  } catch (error) {
    console.error('❌ 오류 발생:', error.message);
  }
}

// 파일 감시 설정
const watcher = chokidar.watch('.', {
  ignored: ignoredFiles.map(f => new RegExp(`(^|/)${f}($|/)`)),
  persistent: true,
  ignoreInitial: true,
  awaitWriteFinish: {
    stabilityThreshold: 200,
    pollInterval: 100
  }
});

console.log('🚀 자동 커밋 감시 시작됨...');
console.log('📁 파일 변경을 감지하면 자동으로 커밋되고 푸시됩니다.\n');

// 파일 변경 감지
watcher.on('add', (filePath) => {
  if (!shouldIgnore(filePath)) {
    console.log(`📄 파일 추가: ${filePath}`);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(autoCommitAndPush, debounceTime);
  }
});

watcher.on('change', (filePath) => {
  if (!shouldIgnore(filePath)) {
    console.log(`✏️ 파일 수정: ${filePath}`);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(autoCommitAndPush, debounceTime);
  }
});

watcher.on('unlink', (filePath) => {
  if (!shouldIgnore(filePath)) {
    console.log(`🗑️ 파일 삭제: ${filePath}`);
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(autoCommitAndPush, debounceTime);
  }
});

watcher.on('error', (error) => {
  console.error('❌ 감시 오류:', error);
});

// 종료 처리
process.on('SIGINT', () => {
  console.log('\n\n🛑 감시 중지됨.');
  watcher.close();
  process.exit(0);
});
