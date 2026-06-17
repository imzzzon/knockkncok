#!/usr/bin/env node

const chokidar = require('chokidar');
const { simpleGit } = require('simple-git');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const git = simpleGit();
const ignoredFiles = ['.git', '.DS_Store', 'node_modules', '.vscode', 'package.json', 'package-lock.json', 'auto-commit.js'];
const debounceTime = 2000; // 2초 대기
const maxRetries = 3; // 최대 재시도 횟수
let debounceTimer = null;
let pendingChanges = new Set();
let isProcessing = false;

// 파일 경로 정규화
function normalizePath(filePath) {
  return filePath.split(path.sep).join('/');
}

// 무시할 파일인지 확인
function shouldIgnore(filePath) {
  const normalized = normalizePath(filePath);
  return ignoredFiles.some(ignored => normalized.includes(ignored));
}

// git lock 파일 정리
function cleanGitLock() {
  try {
    const lockFile = '.git/index.lock';
    if (fs.existsSync(lockFile)) {
      fs.unlinkSync(lockFile);
      console.log('🧹 git lock 파일 정리됨');
    }
  } catch (error) {
    console.error('⚠️ lock 파일 정리 실패:', error.message);
  }
}

// 변경사항 요약 생성
async function generateCommitMessage() {
  try {
    const status = await git.status();
    
    const added = status.created.filter(f => !shouldIgnore(f));
    const modified = status.modified.filter(f => !shouldIgnore(f));
    const deleted = status.deleted.filter(f => !shouldIgnore(f));
    const renamed = status.renamed.filter(f => !shouldIgnore(f[0]));
    
    let message = '📝 자동 커밋: ';
    const changes = [];
    
    if (added.length > 0) {
      changes.push(`추가 ${added.length}개`);
    }
    if (modified.length > 0) {
      changes.push(`수정 ${modified.length}개`);
    }
    if (deleted.length > 0) {
      changes.push(`삭제 ${deleted.length}개`);
    }
    if (renamed.length > 0) {
      changes.push(`이름변경 ${renamed.length}개`);
    }
    
    message += changes.join(', ');
    
    // 구체적인 파일 목록 추가
    let details = '\n\n변경된 파일:\n';
    if (added.length > 0) details += `[추가] ${added.join(', ')}\n`;
    if (modified.length > 0) details += `[수정] ${modified.join(', ')}\n`;
    if (deleted.length > 0) details += `[삭제] ${deleted.join(', ')}\n`;
    if (renamed.length > 0) details += `[이름변경] ${renamed.map(r => `${r[0]} → ${r[1]}`).join(', ')}\n`;
    
    return message + details;
  } catch (error) {
    return '📝 자동 커밋: 변경사항 업데이트';
  }
}

// 자동 커밋 및 푸시 (재시도 로직 포함)
async function autoCommitAndPush(attempt = 1) {
  try {
    // git lock 파일 정리
    cleanGitLock();
    
    if (isProcessing) {
      console.log('⏳ 이미 처리 중입니다...');
      return;
    }
    
    isProcessing = true;
    console.log(`\n🔄 변경사항 감지됨, 처리 중... (시도 ${attempt}/${maxRetries})`);
    
    const status = await git.status();
    
    // 변경사항이 없으면 return
    if (status.files.length === 0) {
      console.log('✨ 커밋할 변경사항이 없습니다.');
      isProcessing = false;
      return;
    }
    
    // 추적되지 않은 파일 무시
    const filesToAdd = status.files
      .filter(f => !shouldIgnore(f.path))
      .map(f => f.path);
    
    if (filesToAdd.length === 0) {
      console.log('✨ 커밋할 변경사항이 없습니다.');
      isProcessing = false;
      return;
    }
    
    // 변경된 파일 add
    await git.add(filesToAdd);
    console.log(`✅ 파일 추가됨: ${filesToAdd.join(', ')}`);
    
    // 커밋 메시지 생성
    const commitMessage = await generateCommitMessage();
    
    // 커밋
    const commit = await git.commit(commitMessage);
    console.log(`✅ 커밋 완료: ${commit.commit}`);
    console.log(commitMessage);
    
    // 푸시 (재시도 로직)
    try {
      await git.push(['origin', 'main']);
      console.log('✅ 푸시 완료!');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      isProcessing = false;
    } catch (pushError) {
      console.error('❌ 푸시 실패:', pushError.message);
      
      // 리모트와의 불일치 가능성이 있으므로 pull 시도
      if (pushError.message.includes('rejected')) {
        console.log('🔄 리모트와 동기화 중...');
        try {
          await git.pull(['--no-rebase', 'origin', 'main']);
          console.log('✅ 동기화 완료, 다시 푸시 시도...');
          await git.push(['origin', 'main']);
          console.log('✅ 푸시 완료!');
          console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
          isProcessing = false;
        } catch (retryError) {
          if (attempt < maxRetries) {
            console.log(`⚠️ 재시도 대기 중... (${attempt}/${maxRetries})`);
            isProcessing = false;
            setTimeout(() => autoCommitAndPush(attempt + 1), 3000);
          } else {
            console.error('❌ 최대 재시도 횟수 초과:', retryError.message);
            isProcessing = false;
          }
        }
      } else {
        if (attempt < maxRetries) {
          console.log(`⚠️ 재시도 대기 중... (${attempt}/${maxRetries})`);
          isProcessing = false;
          setTimeout(() => autoCommitAndPush(attempt + 1), 3000);
        } else {
          console.error('❌ 최대 재시도 횟수 초과');
          isProcessing = false;
        }
      }
    }
    
  } catch (error) {
    console.error('❌ 오류 발생:', error.message);
    isProcessing = false;
    
    // 일시적인 오류일 경우 재시도
    if (attempt < maxRetries) {
      console.log(`⚠️ 재시도 대기 중... (${attempt}/${maxRetries})`);
      setTimeout(() => autoCommitAndPush(attempt + 1), 3000);
    }
  }
}

// 파일 감시 설정
const watcher = chokidar.watch('.', {
  ignored: ignoredFiles.map(f => new RegExp(`(^|/)${f}($|/)`)),
  persistent: true,
  ignoreInitial: true, // 초기 파일들은 무시
  awaitWriteFinish: {
    stabilityThreshold: 100,
    pollInterval: 100
  }
});

console.log('🚀 자동 커밋 감시 시작됨...');
console.log('📁 파일 변경을 감지하면 자동으로 커밋되고 푸시됩니다.\n');

watcher
  .on('add', (filePath) => {
    if (!shouldIgnore(filePath)) {
      console.log(`📄 파일 추가: ${filePath}`);
      pendingChanges.add(filePath);
      scheduleCommit();
    }
  })
  .on('change', (filePath) => {
    if (!shouldIgnore(filePath)) {
      console.log(`✏️ 파일 수정: ${filePath}`);
      pendingChanges.add(filePath);
      scheduleCommit();
    }
  })
  .on('unlink', (filePath) => {
    if (!shouldIgnore(filePath)) {
      console.log(`🗑️ 파일 삭제: ${filePath}`);
      pendingChanges.add(filePath);
      scheduleCommit();
    }
  })
  .on('error', (error) => {
    console.error('❌ 감시 오류:', error);
  });

// 디바운스: 마지막 변경 후 일정 시간 후 커밋
function scheduleCommit() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    autoCommitAndPush();
    pendingChanges.clear();
  }, debounceTime);
}

// 종료 시 감시 중지
process.on('SIGINT', () => {
  console.log('\n\n🛑 감시 중지됨.');
  watcher.close();
  process.exit(0);
});
