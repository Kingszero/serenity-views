#!/usr/bin/env python3
"""
Serenity Views — 数据转换脚本 v2
将 X/Twitter 抓取的原始 JSON 转换为网站 data.js 格式。

输入：浏览器 JS 抓取的 tweets JSON 文件
输出：data.js (window.SERENITY_DATA = {...})

使用方法：
    python generate_data.py tweets.json
    
首次使用流程：
    1. 在浏览器打开 https://x.com/aleabitoreddit
    2. F12 → Console → 粘贴 x_scraper.js → 回车
    3. 等待自动下载 JSON 文件
    4. 把 JSON 放到 scraper/ 目录下
    5. 运行: python generate_data.py serenity_tweets_XXXX.json
    6. 生成的 data.js 会自动覆盖 serenity-views/data.js
"""

import json
import sys
import re
from datetime import datetime
from pathlib import Path
from collections import OrderedDict


def parse_date(date_str):
    for fmt in ['%Y-%m-%dT%H:%M:%S.%fZ', '%Y-%m-%dT%H:%M:%SZ', '%Y-%m-%d']:
        try:
            return datetime.strptime(date_str, fmt)
        except ValueError:
            continue
    return None


def merge_with_existing(new_data, existing_path):
    """合并新数据和已有数据"""
    if not existing_path.exists():
        return new_data
    
    try:
        with open(existing_path, 'r', encoding='utf-8') as f:
            content = f.read()
        # 提取现有数据
        match = re.search(r'window\.SERENITY_DATA\s*=\s*(\{.*?\});', content, re.DOTALL)
        if match:
            existing = json.loads(match.group(1))
            # 新数据覆盖旧数据（同日期以新数据为准）
            existing.update(new_data)
            return existing
    except Exception as e:
        print(f'⚠️  合并失败（将使用新数据）: {e}')
    
    return new_data


def convert_to_site_format(raw_tweets, existing_path=None):
    """
    将原始推文 JSON 转换为网站数据格式
    
    期望输入格式：
    {
      "tweets": [
        {"text": "...", "datetime": "2026-06-04T08:15:00Z", "url": "...", "images": [...]},
        ...
      ]
    }
    """
    tweets = raw_tweets.get('tweets', [])
    if not tweets:
        print('⚠️  没有找到推文数据！')
        return None
    
    # 按日期分组
    by_date = OrderedDict()
    for t in tweets:
        text = (t.get('text') or '').strip()
        if not text or len(text) < 10:
            continue
        
        dt_str = t.get('datetime', '')
        if dt_str:
            dt = parse_date(dt_str)
            if dt:
                key = dt.strftime('%Y-%m-%d')
            else:
                key = dt_str[:10]
        else:
            key = 'unknown'
        
        if key not in by_date:
            by_date[key] = []
        by_date[key].append(t)
    
    # 排序日期
    sorted_dates = sorted(by_date.keys(), reverse=True)
    print(f'📅 共覆盖 {len(sorted_dates)} 个日期')
    
    # 检测每个日期的标题模式
    site_data = OrderedDict()
    for date_str in sorted_dates:
        day_tweets = by_date[date_str]
        dt = parse_date(f'{date_str}T00:00:00Z')
        
        if dt:
            weekdays_cn = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']
            weekdays_en = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
            title_cn = f'{dt.year}年{dt.month}月{dt.day}日 · {weekdays_cn[dt.weekday()]}'
            title_en = f'{weekdays_en[dt.weekday()]}, {dt.strftime("%B %d, %Y")}'
        else:
            title_cn = date_str
            title_en = date_str
        
        # 尝试从推文中提取更好的标题
        title_tweet = None
        for t in day_tweets:
            text = t.get('text', '')
            if any(kw in text.lower() for kw in ['每日观点', 'daily view', 'market view', '市场观点', 'today']):
                title_tweet = t
                break
        
        # 构建观点列表
        views = []
        for i, t in enumerate(day_tweets):
            text = t.get('text', '').strip()
            if not text or len(text) < 20:
                continue
            
            # 自动检测情感
            sentiment = detect_sentiment(text)
            
            # 提取话题
            topic = extract_topic(text)
            
            # 提取标签
            tags_cn = extract_hashtags(text)
            tags_en = extract_hashtags(text)  # 默认相同
            
            # 提取时间
            tweet_dt = parse_date(t.get('datetime', ''))
            time_str = tweet_dt.strftime('%H:%M EST') if tweet_dt else ''
            
            views.append({
                'seq': f'{len(views)+1:02d}',
                'time': time_str,
                'topic': {'cn': topic, 'en': topic},
                'sentiment': sentiment,
                'tags': {'cn': tags_cn[:5], 'en': tags_en[:5]},
                'body': {'cn': text, 'en': text},  # 默认原文，用户可补充翻译
                'original_url': t.get('url', ''),
            })
        
        if not views:
            continue
        
        site_data[date_str] = {
            'dates': {'cn': title_cn, 'en': title_en},
            'views': views,
        }
        
        print(f'  {date_str}: {len(views)} 条观点')
    
    # 合并已有数据
    if existing_path:
        site_data = merge_with_existing(site_data, existing_path)
    
    return site_data


def detect_sentiment(text):
    """自动检测情感倾向"""
    text_lower = text.lower()
    
    bullish = ['看多', '看涨', '利好', '增持', '买入', '超配', '做多', 'bullish', 'buy', 'long',
               'opportunity', '加速', '超预期', '上调', '积极', '乐观']
    bearish = ['看空', '看跌', '利空', '减持', '卖出', '低配', '做空', 'bearish', 'sell', 'short',
               '风险', '谨慎', '下调', '回调', '压力', '扰动']
    
    bull_score = sum(1 for w in bullish if w.lower() in text_lower)
    bear_score = sum(1 for w in bearish if w.lower() in text_lower)
    
    if bull_score > bear_score * 2:
        return 'bullish'
    elif bear_score > bull_score * 2:
        return 'bearish'
    elif bull_score > bear_score:
        return 'bullish'
    elif bear_score > bull_score:
        return 'bearish'
    return 'neutral'


def extract_topic(text):
    """从推文开头提取话题"""
    # 尝试匹配 $SYMBOL
    cashtag = re.search(r'\$([A-Z]{1,5})', text)
    if cashtag:
        return cashtag.group(1)
    
    # 取第一行前50字
    first_line = text.split('\n')[0].strip()
    if len(first_line) > 50:
        first_line = first_line[:50] + '...'
    
    return first_line


def extract_hashtags(text):
    """提取标签"""
    tags = []
    for m in re.finditer(r'#(\w+)', text):
        tags.append(f'#{m.group(1)}')
    for m in re.finditer(r'\$([A-Z]{1,5})', text):
        tags.append(f'${m.group(1)}')
    return tags if tags else ['观点']


def generate_js(site_data, output_path):
    """生成 data.js 文件"""
    json_str = json.dumps(site_data, ensure_ascii=False, indent=2)
    
    js = f"""// Serenity Views — 数据文件
// 自动生成于 {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}
// 来源: X/Twitter @aleabitoreddit
// ⚠️ 此文件自动生成，请勿手动编辑

window.SERENITY_DATA = {json_str};
"""
    
    with open(output_path, 'w', encoding='utf-8') as f:
        f.write(js)
    
    total_views = sum(len(d.get('views', [])) for d in site_data.values())
    print(f'\n✅ data.js 已生成: {output_path}')
    print(f'   📅 {len(site_data)} 个日期')
    print(f'   📝 {total_views} 条观点')
    print(f'   📦 {len(js)} bytes')


def main():
    if len(sys.argv) < 2:
        print('使用方法: python generate_data.py <tweets.json>')
        print('  例: python generate_data.py serenity_tweets_2026-06-10.json')
        print('')
        print('数据采集流程:')
        print('  1. 浏览器打开 https://x.com/aleabitoreddit')
        print('  2. F12 → Console → 粘贴 x_scraper.js → 回车')
        print('  3. 下载的 JSON 放到本目录')
        print('  4. 运行本脚本')
        sys.exit(1)
    
    input_file = Path(sys.argv[1])
    if not input_file.exists():
        print(f'❌ 文件不存在: {input_file}')
        sys.exit(1)
    
    # 读取原始数据
    print(f'📖 读取: {input_file}')
    with open(input_file, 'r', encoding='utf-8') as f:
        raw_data = json.load(f)
    
    total = len(raw_data.get('tweets', []))
    print(f'📦 原始推文: {total} 条')
    
    # 输出路径
    output_dir = Path(__file__).parent.parent  # serenity-views/
    output_path = output_dir / 'data.js'
    
    # 转换
    site_data = convert_to_site_format(raw_data, existing_path=output_path)
    if not site_data:
        print('❌ 转换失败')
        sys.exit(1)
    
    # 生成 data.js
    generate_js(site_data, str(output_path))
    
    # 打印摘要
    print(f'\n{"="*60}')
    print('📊 数据摘要（最近 5 天）')
    print('='*60)
    for i, (date, data) in enumerate(site_data.items()):
        if i >= 5:
            break
        views = data.get('views', [])
        print(f'\n📅 {data["dates"]["cn"]}')
        for v in views[:3]:
            preview = v['body']['cn'][:60].replace('\n', ' ')
            print(f'   [{v["seq"]}] {preview}...')
        if len(views) > 3:
            print(f'   ... 还有 {len(views)-3} 条')
    
    print(f'\n🚀 下一步:')
    print(f'   1. git add data.js && git commit -m "Update Serenity views"')
    print(f'   2. git push')
    print(f'   3. 等待 1-2 分钟，刷新网站')


if __name__ == '__main__':
    main()
