/**
 * Serenity Views — X/Twitter 推文抓取脚本
 * 
 * 使用方法：
 * 1. 在浏览器打开 https://x.com/aleabitoreddit
 * 2. 按 F12 打开开发者工具，切换到 Console（控制台）标签
 * 3. 复制粘贴整段代码，按回车执行
 * 4. 脚本会自动滚动加载历史推文，完成后自动下载 JSON 文件
 * 
 * 参数说明：
 * - SCROLL_COUNT: 滚动次数（每次加载约20条推文），默认200次可覆盖约4000条
 * - SCROLL_DELAY: 每次滚动间隔（毫秒），太短可能被限速
 */

(async function scrapeXTimeline() {
  const SCROLL_COUNT = 200;   // 滚动次数
  const SCROLL_DELAY = 1500;  // 滚动间隔ms
  const tweets = [];
  const seen = new Set();

  function log(msg) {
    console.log(`[Serenity Scraper] ${msg}`);
  }

  // 从推文元素中提取内容
  function extractTweet(el) {
    try {
      // 获取推文链接（含唯一ID）
      const linkEl = el.querySelector('a[href*="/status/"]');
      if (!linkEl) return null;
      const href = linkEl.getAttribute('href');
      const match = href.match(/\/status\/(\d+)/);
      if (!match) return null;
      const tweetId = match[1];
      if (seen.has(tweetId)) return null;
      seen.add(tweetId);

      // 获取推文文本
      const textEl = el.querySelector('[data-testid="tweetText"]');
      const text = textEl ? textEl.innerText.trim() : '';

      // 获取时间
      const timeEl = el.querySelector('time');
      const datetime = timeEl ? timeEl.getAttribute('datetime') : '';

      // 获取互动数据
      const replyEl = el.querySelector('[data-testid="reply"]');
      const retweetEl = el.querySelector('[data-testid="retweet"]');
      const likeEl = el.querySelector('[data-testid="like"]');

      const stats = {
        replies: replyEl ? parseInt(replyEl.getAttribute('aria-label')?.match(/\d+/)?.[0] || '0') : 0,
        retweets: retweetEl ? parseInt(retweetEl.getAttribute('aria-label')?.match(/\d+/)?.[0] || '0') : 0,
        likes: likeEl ? parseInt(likeEl.getAttribute('aria-label')?.match(/\d+/)?.[0] || '0') : 0,
      };

      // 获取图片链接
      const imgEls = el.querySelectorAll('img[src*="pbs.twimg.com/media"]');
      const images = [...imgEls].map(img => img.src).filter(Boolean);

      return { tweetId, text, datetime, stats, images, url: `https://x.com/aleabitoreddit/status/${tweetId}` };
    } catch (e) {
      return null;
    }
  }

  log('开始抓取 @aleabitoreddit 的推文...');
  log(`计划滚动 ${SCROLL_COUNT} 次，间隔 ${SCROLL_DELAY}ms`);

  for (let i = 0; i < SCROLL_COUNT; i++) {
    // 提取当前页面可见推文
    const tweetEls = document.querySelectorAll('[data-testid="tweet"]');
    let newCount = 0;
    for (const el of tweetEls) {
      const tweet = extractTweet(el);
      if (tweet && tweet.text) {
        tweets.push(tweet);
        newCount++;
      }
    }

    if (newCount > 0 || i % 10 === 0) {
      log(`第 ${i + 1}/${SCROLL_COUNT} 轮 | 本轮 +${newCount} | 累计 ${tweets.length} 条`);
    }

    // 滚动到底部
    window.scrollTo(0, document.body.scrollHeight);
    await new Promise(r => setTimeout(r, SCROLL_DELAY));

    // 如果连续多轮没有新推文，可能到底了
    if (i > 10 && newCount === 0) {
      const emptyRounds = [...Array(5)].filter((_, j) => {
        const recent = tweets.slice(-(j+1)*20);
        return recent.length === 0;
      }).length;
      if (newCount === 0) {
        log('连续无新推文，可能已到底，再试几轮...');
      }
    }
  }

  log(`抓取完成！共获取 ${tweets.length} 条推文`);

  // 按日期分组统计
  const byDate = {};
  for (const t of tweets) {
    const date = t.datetime ? t.datetime.slice(0, 10) : 'unknown';
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(t);
  }
  console.table(Object.entries(byDate).map(([date, arr]) => ({ 日期: date, 推文数: arr.length })));

  // 下载 JSON
  const filename = `serenity_tweets_${new Date().toISOString().slice(0, 10)}.json`;
  const blob = new Blob([JSON.stringify({ 
    scrapedAt: new Date().toISOString(),
    account: 'aleabitoreddit', 
    totalTweets: tweets.length, 
    byDate: Object.fromEntries(
      Object.entries(byDate).sort(([a], [b]) => b.localeCompare(a))
    ),
    tweets: tweets.sort((a, b) => b.datetime.localeCompare(a.datetime))
  }, null, 2)], { type: 'application/json' });
  
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  
  log(`文件已下载: ${filename}`);
  log(`请将此文件放到项目目录 serenity-views/scraper/ 下，然后运行 python generate_data.py`);

  return { total: tweets.length, filename };
})();
