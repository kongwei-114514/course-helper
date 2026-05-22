/**
 * 选课规划器 v2
 * - 课表格子修正：节次→课时行数正确映射
 * - 表头紧凑
 * - 班级实例内加"查看评价"按钮，弹出本地评价数据
 */
class SchedulePlanner {
  constructor(reviewsData) {
    // 节次定义：每大节占几个"行单元"（1行单元 = 1课时 ≈ 45min）
    // 第1节: 2课时, 第2节: 3课时, 第3节: 2课时
    // 第4节: 2课时, 第5节: 2课时, 第6节: 3课时  合计 14 行
    this.PERIODS = [
      { id: 1, label: '第1节', time: '08:00–09:35', rows: 2 },
      { id: 2, label: '第2节', time: '09:50–12:15', rows: 3 },
      { id: 3, label: '第3节', time: '13:30–15:05', rows: 2 },
      { id: 4, label: '第4节', time: '15:20–16:55', rows: 2 },
      { id: 5, label: '第5节', time: '17:05–18:40', rows: 2 },
      { id: 6, label: '第6节', time: '19:20–21:45', rows: 3 },
    ];
    // 每个节次在网格中起始行（0-indexed）
    let r = 0;
    this.PERIODS.forEach(p => { p.startRow = r; r += p.rows; });
    this.TOTAL_ROWS = r; // = 14

    this.DAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

    this.reviewsData = reviewsData || null;
    this.scheduleData = null;
    this.nextSemesterData = null;
    this.enrollmentStatsData = null;
    this.enrollmentStatsMap = new Map();
    this.selectedKeys = new Set();   // "courseId::courseSeq"
    this.selectedCourses = new Map();// key -> courseObj
    this.preferencePlan = {};

    this.currentView = 'recommended';
    this.searchQuery = '';
    this.filterType = 'all';
    this.searchGroupFilter = 'all';
    this.recommendationTypes = [
      { key: 'required', label: '必修', order: 1, color: '#4CAF50', bg: '#edf7ee', text: '#2e7d32', border: '#b9dfbd' },
      { key: 'limited', label: '限选', order: 2, color: '#E6A817', bg: '#fff6dc', text: '#8a5a00', border: '#f0d58a' },
      { key: 'elective', label: '任选', order: 3, color: '#5B8DEF', bg: '#eef4ff', text: '#2559b6', border: '#bfd2fb' },
    ];
    this.preferenceTypes = [
      ...this.recommendationTypes,
      { key: 'sports', label: '体育', order: 4, color: '#14B8A6', bg: '#ecfdf5', text: '#0f766e', border: '#99f6e4' },
    ];
    this.defaultRecommendationType = {
      key: 'other', label: '其他', order: 99, color: '#9CA3AF', bg: '#f3f4f6', text: '#4b5563', border: '#d1d5db'
    };
    this.searchGroupOptions = [
      { key: 'art', label: '艺术课组' },
      { key: 'humanities', label: '人文科组' },
      { key: 'science', label: '科学课组' },
      { key: 'social', label: '社科课组' },
    ];

    this.colors = [
      '#a8d8a8','#aec6cf','#ffd1dc','#ffdead','#c3b1e1',
      '#b5ead7','#f8c8c8','#c9daf8','#ffe4b5','#d5e8d4',
      '#d4e1f7','#f9e4b7','#e8d5f5','#c5e0dc','#f5cba7'
    ];
    this.colorMap = new Map();
    this.colorIdx = 0;
  }

  // ==================== 数据加载 ====================
  async loadData() {
    return new Promise(resolve => {
      chrome.storage.local.get(['courseScheduleData', 'nextSemesterData', 'selectedCourses', 'selectedPreferencePlan', 'selectedPreferenceOrder', 'preferenceOrder', 'enrollmentStatsData'], r => {
        this.scheduleData = r.courseScheduleData || null;
        this.nextSemesterData = r.nextSemesterData || null;
        this.enrollmentStatsData = r.enrollmentStatsData || null;
        this.preferencePlan = this._normalizePreferencePlan(r.selectedPreferencePlan, r.selectedPreferenceOrder || r.preferenceOrder);
        this._buildEnrollmentStatsMap();
        if (r.selectedCourses) {
          this.selectedKeys = new Set(r.selectedCourses);
          this._rebuildSelected();
        }
        this._syncPreferencePlan();
        resolve();
      });
    });
  }

  _rebuildSelected() {
    if (!this.scheduleData?.data) return;
    for (const key of this.selectedKeys) {
      const [cid, seq] = key.split('::');
      const c = this.scheduleData.data.find(x => x.courseId === cid && x.courseSeq === seq);
      if (c) { this.selectedCourses.set(key, c); this._getColor(c.courseId); }
    }
  }

  _save() {
    this._syncPreferencePlan();
    chrome.storage.local.set({
      selectedCourses: Array.from(this.selectedKeys),
      selectedPreferencePlan: this.preferencePlan,
    });
  }

  _buildEnrollmentStatsMap() {
    this.enrollmentStatsMap = new Map();
    if (!this.enrollmentStatsData?.sources) return;
    if (this.scheduleData?.xnxq && this.enrollmentStatsData.xnxq && this.scheduleData.xnxq !== this.enrollmentStatsData.xnxq) return;

    const rows = [
      ...(this.enrollmentStatsData.sources.BR?.rows || []),
      ...(this.enrollmentStatsData.sources.Ty?.rows || []),
    ];

    for (const row of rows) {
      if (!row.courseId || !row.courseSeq) continue;
      this.enrollmentStatsMap.set(`${row.courseId}::${row.courseSeq}`, row);
    }
  }

  _getEnrollmentStats(course) {
    if (!course) return null;
    return this.enrollmentStatsMap.get(`${course.courseId}::${course.courseSeq}`) || null;
  }

  _prefTupleHTML(label, prefs, activeRank = null) {
    if (!prefs || !prefs.raw) return '';
    return `
      <span class="sp-pref-pill ${activeRank === 1 ? 'active' : ''}">${label}一 ${prefs.first}</span>
      <span class="sp-pref-pill ${activeRank === 2 ? 'active' : ''}">${label}二 ${prefs.second}</span>
      <span class="sp-pref-pill ${activeRank === 3 ? 'active' : ''}">${label}三 ${prefs.third}</span>`;
  }

  _enrollmentHTML(stats, course = null) {
    if (!stats) return '';
    const pref = course ? this._getCoursePreference(course) : null;
    const probability = course ? this._admissionProbability(course, stats) : null;
    const probabilityHTML = probability ? `
      <span class="sp-prob-pill ${probability.className}">预计 ${probability.text}</span>` : '';
    const prefsHTML = stats.source === 'Ty'
      ? this._prefTupleHTML('体育', stats.sportsPrefs, pref?.rank)
      : [
          this._prefTupleHTML('必修', stats.requiredPrefs, pref?.typeKey === 'required' ? pref.rank : null),
          this._prefTupleHTML('限选', stats.limitedPrefs, pref?.typeKey === 'limited' ? pref.rank : null),
          this._prefTupleHTML('任选', stats.electivePrefs, pref?.typeKey === 'elective' ? pref.rank : null),
        ].filter(Boolean).join('');
    const ratio = stats.capacity ? `${stats.totalApplicants}/${stats.capacity}` : `${stats.totalApplicants}`;

    return `
      <div class="sp-enroll-row">
        <span class="sp-enroll-main">报名 ${ratio}</span>
        ${probabilityHTML}
        <div class="sp-pref-list">${prefsHTML}</div>
      </div>`;
  }

  _getColor(courseId) {
    if (!this.colorMap.has(courseId)) {
      this.colorMap.set(courseId, this.colors[this.colorIdx % this.colors.length]);
      this.colorIdx++;
    }
    return this.colorMap.get(courseId);
  }

  _getRecommendationType(type) {
    const text = String(type || '').trim();
    return this.recommendationTypes.find(t => text.includes(t.label)) || {
      ...this.defaultRecommendationType,
      label: text || this.defaultRecommendationType.label
    };
  }

  _preferenceTypeForCourse(course) {
    const stats = this._getEnrollmentStats(course);
    const isSportsCourse = stats?.source === 'Ty' ||
      String(course?.courseName || '').trim().startsWith('体育') ||
      String(course?.courseId || '').startsWith('1072');
    if (isSportsCourse) {
      return this.preferenceTypes.find(type => type.key === 'sports');
    }
    if (!course?.courseId || !this.nextSemesterData?.courses) {
      return this.recommendationTypes.find(type => type.key === 'elective');
    }
    let rec = null;
    for (const item of this.nextSemesterData.courses) {
      if (item.courseId === course.courseId) rec = item;
    }
    if (!rec) return this.recommendationTypes.find(type => type.key === 'elective');
    const type = this._getRecommendationType(rec.type);
    return this.recommendationTypes.some(item => item.key === type.key) ? type : null;
  }

  _normalizePreferencePlan(savedPlan, oldOrder) {
    const plan = {};
    if (savedPlan && typeof savedPlan === 'object' && !Array.isArray(savedPlan)) {
      for (const [key, value] of Object.entries(savedPlan)) {
        if (typeof key !== 'string') continue;
        const typeKey = this.preferenceTypes.some(type => type.key === value?.typeKey) ? value.typeKey : 'elective';
        const rank = [1, 2, 3].includes(Number(value?.rank)) ? Number(value.rank) : 3;
        plan[key] = { typeKey, rank };
      }
    }

    // 旧版是每类一个排序数组；迁移时不继承自动顺序，全部改成手动三志愿。
    if (!Object.keys(plan).length && oldOrder && typeof oldOrder === 'object') {
      for (const type of this.recommendationTypes) {
        for (const key of oldOrder[type.key] || []) {
          if (typeof key === 'string') plan[key] = { typeKey: type.key, rank: 3 };
        }
      }
    }
    return plan;
  }

  _syncPreferencePlan() {
    const nextPlan = {};
    for (const [key, course] of this.selectedCourses) {
      const type = this._preferenceTypeForCourse(course);
      if (!type) continue;
      const saved = this.preferencePlan?.[key] || {};
      nextPlan[key] = {
        typeKey: type.key,
        rank: [1, 2, 3].includes(Number(saved.rank)) ? Number(saved.rank) : 3,
      };
    }

    const rankCounts = {};
    for (const type of this.preferenceTypes) {
      rankCounts[type.key] = { 1: 0, 2: 0 };
    }
    for (const key of Object.keys(nextPlan)) {
      const pref = nextPlan[key];
      if (pref.rank === 1 || pref.rank === 2) {
        const limit = pref.rank === 1 ? 1 : 2;
        if (rankCounts[pref.typeKey][pref.rank] >= limit) {
          pref.rank = 3;
        } else {
          rankCounts[pref.typeKey][pref.rank]++;
        }
      }
    }
    this.preferencePlan = nextPlan;
  }

  _getCoursePreference(courseOrKey) {
    const key = typeof courseOrKey === 'string'
      ? courseOrKey
      : courseOrKey ? `${courseOrKey.courseId}::${courseOrKey.courseSeq}` : '';
    const course = typeof courseOrKey === 'string' ? this.selectedCourses.get(key) : courseOrKey;
    const fallbackType = this._preferenceTypeForCourse(course);
    const saved = this.preferencePlan?.[key] || {};
    return {
      typeKey: fallbackType?.key || 'elective',
      rank: [1, 2, 3].includes(Number(saved.rank)) ? Number(saved.rank) : 3,
    };
  }

  _preferenceCount(typeKey, rank, excludeKey = null) {
    let count = 0;
    for (const [key, course] of this.selectedCourses) {
      if (key === excludeKey) continue;
      const pref = this._getCoursePreference(course);
      if (pref.typeKey === typeKey && pref.rank === rank) count++;
    }
    return count;
  }

  _canSetPreference(key, typeKey, rank) {
    if (rank === 3) return true;
    const limit = rank === 1 ? 1 : 2;
    return this._preferenceCount(typeKey, rank, key) < limit;
  }

  _rankLabel(rank) {
    return `${rank}志愿`;
  }

  _rankClass(rank) {
    return `rank${rank}`;
  }

  _setPreferenceRank(typeKey, key, rank) {
    rank = Number(rank);
    if (![1, 2, 3].includes(rank)) return;
    if (!this._canSetPreference(key, typeKey, rank)) return;
    const current = this._getCoursePreference(key);
    this.preferencePlan[key] = { typeKey: current.typeKey || typeKey, rank };
    this._save();
    this.render();
  }

  _prefCountsForStats(stats, typeKey) {
    if (!stats) return null;
    if (stats.source === 'Ty') return typeKey === 'sports' ? (stats.sportsPrefs || null) : null;
    const keyMap = {
      required: stats.requiredPrefs,
      limited: stats.limitedPrefs,
      elective: stats.electivePrefs,
    };
    return keyMap[typeKey] || null;
  }

  _inlinePrefCountsHTML(stats, typeKey, activeRank) {
    const prefs = this._prefCountsForStats(stats, typeKey);
    if (!prefs || !prefs.raw) return '<span class="sp-pref-inline muted">志愿人数暂无</span>';
    return `
      <span class="sp-pref-inline ${activeRank === 1 ? 'active' : ''}">一 ${prefs.first}</span>
      <span class="sp-pref-inline ${activeRank === 2 ? 'active' : ''}">二 ${prefs.second}</span>
      <span class="sp-pref-inline ${activeRank === 3 ? 'active' : ''}">三 ${prefs.third}</span>`;
  }

  _preferenceStatsMatrixHTML(stats, pref) {
    if (!stats) return '<div class="sp-pref-matrix muted">志愿人数暂无</div>';
    const rows = stats.source === 'Ty'
      ? [this.preferenceTypes.find(type => type.key === 'sports')]
      : this.recommendationTypes;

    return `
      <div class="sp-pref-matrix">
        ${rows.filter(Boolean).map(type => {
          const activeRank = pref.typeKey === type.key ? pref.rank : null;
          const countsHTML = this._inlinePrefCountsHTML(stats, type.key, activeRank);
          return `
            <div class="sp-pref-matrix-row">
              <span class="sp-pref-matrix-label">${type.label}</span>
              <span class="sp-pref-inline-list">${countsHTML}</span>
            </div>`;
        }).join('')}
      </div>`;
  }

  _capacityHTML(stats) {
    if (!stats) return '<span class="sp-pref-cap muted">容量暂无</span>';
    const capacity = stats.capacity || 0;
    const total = stats.totalApplicants || 0;
    return `<span class="sp-pref-cap">报名/容量 ${total}/${capacity || '-'}</span>`;
  }

  _admissionProbability(course, stats) {
    if (!stats || !stats.capacity) return null;
    const pref = this._getCoursePreference(course);
    const capacity = Math.max(Number(stats.capacity) || 0, 0);
    const prefixApplicants = (tuple, rank) => {
      if (!tuple || rank <= 1) return 0;
      if (rank === 2) return tuple.first || 0;
      return (tuple.first || 0) + (tuple.second || 0);
    };

    let applicantsBefore = 0;
    let sameRankApplicants = 0;
    if (stats.source === 'Ty') {
      const prefs = stats.sportsPrefs;
      applicantsBefore = prefixApplicants(prefs, pref.rank);
      sameRankApplicants = pref.rank === 1 ? prefs?.first : pref.rank === 2 ? prefs?.second : prefs?.third;
    } else {
      const orderedTypes = ['required', 'limited', 'elective'];
      for (const typeKey of orderedTypes) {
        const prefs = this._prefCountsForStats(stats, typeKey);
        if (!prefs) continue;
        if (typeKey === pref.typeKey) {
          applicantsBefore += prefixApplicants(prefs, pref.rank);
          sameRankApplicants = pref.rank === 1 ? prefs.first : pref.rank === 2 ? prefs.second : prefs.third;
          break;
        }
        applicantsBefore += prefs.total || 0;
      }
    }

    sameRankApplicants = Math.max(Number(sameRankApplicants) || 0, 0);
    const remaining = capacity - applicantsBefore;
    let percent = sameRankApplicants <= 0
      ? (remaining > 0 ? 100 : 0)
      : Math.max(0, Math.min(100, (remaining / sameRankApplicants) * 100));
    if (remaining >= sameRankApplicants) percent = 100;
    const rounded = Math.round(percent);
    return {
      percent: rounded,
      text: `${rounded}%`,
      className: rounded >= 80 ? 'high' : rounded >= 40 ? 'mid' : 'low',
    };
  }

  _courseSearchText(course) {
    return [
      course.department,
      course.courseId,
      course.courseSeq,
      course.courseName,
      course.teacher,
      course.notes,
      course.generalGroup,
      course.grade,
      course.hasTimeLimit,
      ...(Array.isArray(course.features) ? course.features : []),
    ].filter(Boolean).join(' ');
  }

  _matchesSearchGroup(course) {
    if (this.searchGroupFilter === 'all') return true;
    const option = this.searchGroupOptions.find(o => o.key === this.searchGroupFilter);
    if (!option) return true;
    return this._normalizeGroupName(course.generalGroup) === this._normalizeGroupName(option.label);
  }

  _normalizeGroupName(value) {
    return String(value || '')
      .replace(/\s+/g, '')
      .replace(/[（(].*?[）)]/g, '')
      .replace(/^通识选修/, '')
      .replace(/科组/g, '课组')
      .trim();
  }

  _groupHasConflict(group) {
    const candidates = group.instances.filter(inst => {
      const key = `${inst.courseId}::${inst.courseSeq}`;
      return !this.selectedKeys.has(key);
    });
    if (!candidates.length) return false;

    return candidates.every(inst => {
      const key = `${inst.courseId}::${inst.courseSeq}`;
      return this.wouldConflict(key, inst);
    });
  }

  _groupHasTeacherReview(group) {
    return group.instances.some(inst => !!this.getReviewForTeacher(group.courseName, inst.teacher));
  }

  _searchSectionLabel(group) {
    const conflictText = group.hasConflict ? '冲突' : '不冲突';
    const reviewText = group.hasReview ? '有评价' : '无评价';
    return `${conflictText} · ${reviewText}`;
  }

  _getLimitTags(course) {
    const rawText = [
      course.notes,
      course.generalGroup,
      course.hasTimeLimit,
      ...(Array.isArray(course.features) ? course.features : []),
    ].filter(Boolean).join('；');
    const compactText = rawText.replace(/\s+/g, '');
    const matches = compactText.match(/限[^；;，,、。.\s]{1,20}(?:级|系|院系|专业|班|书院|项目|实验班)?选课/g) || [];
    const directMatches = compactText.match(/限[^；;，,、。.\s]{1,20}(?:级|系|院系|专业|班|书院|项目|实验班)/g) || [];

    const tags = Array.from(new Set([...matches, ...directMatches]))
      .filter(tag => !/^限选课?$/.test(tag));

    return tags
      .filter(tag => !tags.some(other => other !== tag && other.includes(tag)))
      .slice(0, 2);
  }

  // ==================== Schedule 解析 ====================
  parseSchedule(str) {
    if (!str || !str.trim()) return [];
    const slots = [];
    str.split(',').forEach(part => {
      part = part.trim();
      const m = part.match(/^(\d+)-(\d+)\(([^)]+)\)$/);
      if (m) slots.push({ day: +m[1], period: +m[2], qualifier: m[3] });
    });
    return slots;
  }

  _slotsConflict(s1, s2) {
    // 单周和双周之间不冲突
    if ((s1.qualifier === '单周' && s2.qualifier === '双周') ||
        (s1.qualifier === '双周' && s2.qualifier === '单周')) return false;
    return s1.day === s2.day && s1.period === s2.period;
  }

  detectConflicts() {
    const conflicts = new Set();
    const list = Array.from(this.selectedCourses.entries());
    for (let i = 0; i < list.length; i++) {
      const slots1 = this.parseSchedule(list[i][1].schedule);
      for (let j = i + 1; j < list.length; j++) {
        const slots2 = this.parseSchedule(list[j][1].schedule);
        let found = false;
        for (const s1 of slots1) for (const s2 of slots2) if (this._slotsConflict(s1, s2)) found = true;
        if (found) { conflicts.add(list[i][0]); conflicts.add(list[j][0]); }
      }
    }
    return conflicts;
  }

  wouldConflict(newKey, newCourse) {
    const newSlots = this.parseSchedule(newCourse.schedule);
    for (const [key, c] of this.selectedCourses) {
      if (key === newKey) continue;
      const slots = this.parseSchedule(c.schedule);
      for (const s1 of newSlots) for (const s2 of slots) if (this._slotsConflict(s1, s2)) return true;
    }
    return false;
  }

  // ==================== 评价查询 ====================
  getReviewsForCourse(courseName) {
    if (!this.reviewsData?.courses) return [];
    return this.reviewsData.courses
      .filter(c => c.course_name === courseName ||
        (courseName.length >= 4 && c.course_name.includes(courseName.slice(0, 6))) ||
        (c.course_name.length >= 4 && courseName.includes(c.course_name.slice(0, 6))))
      .sort((a, b) => b.rating - a.rating);
  }

  getReviewForTeacher(courseName, teacherName) {
    return this.reviewsData?.courses?.find(
      c => (c.course_name === courseName || courseName.includes(c.course_name.slice(0, 4))) &&
           c.course_teacher === teacherName
    ) || null;
  }

  getBestRating(courseName) {
    const reviews = this.getReviewsForCourse(courseName);
    if (!reviews.length) return null;
    return Math.max(...reviews.map(r => r.rating));
  }

  // ==================== 主渲染 ====================
  render() {
    this._renderPanel();
    this._renderRight();
    this._bindEvents();
  }

  _renderPanel() {
    const el = document.getElementById('spPanel');
    if (!el) return;
    el.innerHTML = this._panelHTML();
  }

  _renderRight() {
    const el = document.getElementById('spRight');
    if (!el) return;
    el.innerHTML = this._statsHTML() + this._timetableHTML() + this._noTimeHTML() + this._preferencePlanHTML();
    // 绑定课表格子点击移除
    el.querySelectorAll('.sp-block[data-key]').forEach(b => {
      b.addEventListener('click', e => { e.stopPropagation(); this._removeCourse(b.dataset.key); });
    });
    el.querySelectorAll('.sp-nt-rm').forEach(b => {
      b.addEventListener('click', () => this._removeCourse(b.dataset.key));
    });
    el.querySelectorAll('.sp-pref-rank-btn').forEach(b => {
      b.addEventListener('click', () => this._setPreferenceRank(b.dataset.type, b.dataset.key, Number(b.dataset.rank)));
    });
    document.getElementById('spClearBtn')?.addEventListener('click', () => {
      if (confirm('确定清空课表？')) { this.selectedKeys.clear(); this.selectedCourses.clear(); this.colorMap.clear(); this.colorIdx = 0; this._save(); this.render(); }
    });
    document.getElementById('spExportBtn')?.addEventListener('click', () => this._exportPlan());
  }

  // ==================== 面板 HTML ====================
  _panelHTML() {
    const hasSchedule = !!this.scheduleData;
    const hasNext = !!this.nextSemesterData;
    const recCount = this.nextSemesterData?.courses?.length || 0;

    const noticeHTML = (!hasSchedule || !hasNext) ? `
      <div class="sp-notice">
        ${!hasSchedule ? '⚠️ 缺少开课数据，请点击顶部「抓取开课信息」<br>' : ''}
        ${!hasNext ? '⚠️ 缺少推荐课单，请点击顶部「下学期推荐课」' : ''}
      </div>` : '';

    const viewTabsHTML = `
      <div class="sp-view-tabs">
        <button class="sp-vtab ${this.currentView === 'recommended' ? 'active' : ''}" data-view="recommended">
          计划课程 <span class="sp-vtab-count">${recCount}</span>
        </button>
        <button class="sp-vtab ${this.currentView === 'search' ? 'active' : ''}" data-view="search">
          全局搜索
        </button>
      </div>`;

    const searchGroupOptionsHTML = this.searchGroupOptions.map(option =>
      `<option value="${option.key}" ${this.searchGroupFilter === option.key ? 'selected' : ''}>${option.label}</option>`
    ).join('');

    const controlHTML = this.currentView === 'search'
      ? `<div class="sp-search-controls">
           <input class="sp-search" id="spSearch" placeholder="课程名、课程号、教师..." value="${this.searchQuery}">
           <select class="sp-search-type" id="spSearchGroupFilter">
             <option value="all">全部课组</option>
             ${searchGroupOptionsHTML}
           </select>
         </div>`
      : `<select class="sp-filter-select" id="spTypeFilter">
           <option value="all">全部类型</option>
           <option value="必修" ${this.filterType === '必修' ? 'selected' : ''}>必修</option>
           <option value="限选" ${this.filterType === '限选' ? 'selected' : ''}>限选</option>
           <option value="任选" ${this.filterType === '任选' ? 'selected' : ''}>任选</option>
         </select>`;

    return `
      <div class="sp-panel-header">
        <div class="sp-panel-title">课程选择</div>
        ${noticeHTML}
        ${viewTabsHTML}
        ${controlHTML}
      </div>
      <div class="sp-list" id="spList">${this._courseListHTML()}</div>`;
  }

  _courseListHTML() {
    if (!this.scheduleData?.data) {
      return `<div class="sp-empty"><div class="sp-empty-icon">📭</div><p>暂无开课数据</p></div>`;
    }

    let courses = [];
    let recById = new Map();
    if (this.currentView === 'recommended' && this.nextSemesterData?.courses) {
      recById = new Map(this.nextSemesterData.courses.map(c => [c.courseId, c]));
      const recIds = new Set(recById.keys());
      let recCourses = this.scheduleData.data
        .filter(c => recIds.has(c.courseId))
        .map(c => ({ ...c, recInfo: recById.get(c.courseId) }));
      if (this.filterType !== 'all') {
        const typeIds = new Set(
          this.nextSemesterData.courses.filter(c => c.type === this.filterType).map(c => c.courseId)
        );
        recCourses = recCourses.filter(c => typeIds.has(c.courseId));
      }
      recCourses.sort((a, b) => {
        const ta = this._getRecommendationType(a.recInfo?.type);
        const tb = this._getRecommendationType(b.recInfo?.type);
        if (ta.order !== tb.order) return ta.order - tb.order;
        const groupCmp = String(a.recInfo?.group || '').localeCompare(String(b.recInfo?.group || ''), 'zh-CN');
        if (groupCmp !== 0) return groupCmp;
        const nameCmp = String(a.courseName || '').localeCompare(String(b.courseName || ''), 'zh-CN');
        if (nameCmp !== 0) return nameCmp;
        return String(a.courseId || '').localeCompare(String(b.courseId || ''));
      });
      courses = recCourses;
    } else if (this.currentView === 'search') {
      const q = this.searchQuery.toLowerCase();
      courses = this.scheduleData.data.filter(c =>
        this._matchesSearchGroup(c) &&
        (!q ||
          c.courseName?.toLowerCase().includes(q) ||
          c.courseId?.includes(q) ||
          c.teacher?.toLowerCase().includes(q))
      ).slice(0, 120);
      if (!this.searchQuery && this.searchGroupFilter === 'all') return `<div class="sp-empty"><div class="sp-empty-icon">🔍</div><p>输入关键词搜索，或选择课组筛选</p></div>`;
      if (!courses.length) return `<div class="sp-empty"><p>未找到相关课程</p></div>`;
    }

    if (!courses.length) return `<div class="sp-empty"><p>无符合条件的课程</p></div>`;

    // 按 courseId 分组
    const groupMap = new Map();
    for (const c of courses) {
      if (!groupMap.has(c.courseId)) {
        groupMap.set(c.courseId, { courseId: c.courseId, courseName: c.courseName, recInfo: c.recInfo || null, instances: [] });
      }
      groupMap.get(c.courseId).instances.push(c);
    }

    const conflicts = this.detectConflicts();
    let groups = Array.from(groupMap.values());
    if (this.currentView === 'search') {
      groups = groups.map(group => ({
        ...group,
        hasConflict: this._groupHasConflict(group),
        hasReview: this._groupHasTeacherReview(group),
      })).sort((a, b) => {
        if (a.hasConflict !== b.hasConflict) return a.hasConflict ? 1 : -1;
        if (a.hasReview !== b.hasReview) return a.hasReview ? -1 : 1;
        const nameCmp = String(a.courseName || '').localeCompare(String(b.courseName || ''), 'zh-CN');
        if (nameCmp !== 0) return nameCmp;
        return String(a.courseId || '').localeCompare(String(b.courseId || ''));
      });
    }

    let lastTypeKey = null;
    let lastSearchSection = null;
    return groups.map(g => {
      const anySelected = g.instances.some(i => this.selectedKeys.has(`${i.courseId}::${i.courseSeq}`));
      const recType = this.currentView === 'recommended' ? this._getRecommendationType(g.recInfo?.type) : null;
      const color = recType ? recType.color : this._getColor(g.courseId);
      const typeTagHTML = recType
        ? `<span class="sp-type-tag" style="--type-bg:${recType.bg};--type-text:${recType.text};--type-border:${recType.border};">${recType.label}</span>`
        : '';
      const sectionHTML = recType && this.filterType === 'all' && recType.key !== lastTypeKey
        ? `<div class="sp-type-section" style="--type-color:${recType.color};">${recType.label}</div>`
        : '';
      if (recType) lastTypeKey = recType.key;
      const searchSectionLabel = this.currentView === 'search' ? this._searchSectionLabel(g) : '';
      const searchSectionHTML = searchSectionLabel && searchSectionLabel !== lastSearchSection
        ? `<div class="sp-type-section sp-search-section">${searchSectionLabel}</div>`
        : '';
      if (searchSectionLabel) lastSearchSection = searchSectionLabel;

      // 计算有评价的老师数量（用于课程组标签）
      const allReviews = this.getReviewsForCourse(g.courseName);
      const reviewedTeachers = new Set(allReviews.map(r => r.course_teacher));
      const reviewedCount = g.instances.filter(i => i.teacher && reviewedTeachers.has(i.teacher)).length;
      const hasReview = reviewedCount > 0;
      const reviewTagHTML = hasReview
        ? `<span class="sp-review-tag has-review">有评价 ${reviewedCount}/${g.instances.length}</span>`
        : `<span class="sp-review-tag no-review">无评价</span>`;

      const displayInstances = [...g.instances].sort((a, b) => {
        const keyA = `${a.courseId}::${a.courseSeq}`;
        const keyB = `${b.courseId}::${b.courseSeq}`;
        const selA = this.selectedKeys.has(keyA);
        const selB = this.selectedKeys.has(keyB);
        if (selA !== selB) return selA ? -1 : 1;
        const conflictA = !selA && this.wouldConflict(keyA, a);
        const conflictB = !selB && this.wouldConflict(keyB, b);
        if (conflictA !== conflictB) return conflictA ? 1 : -1;
        return String(a.courseSeq || '').localeCompare(String(b.courseSeq || ''), 'zh-CN');
      });

      const instancesHTML = displayInstances.map(inst => {
        const key = `${inst.courseId}::${inst.courseSeq}`;
        const isSel = this.selectedKeys.has(key);
        const isConflict = conflicts.has(key);
        const slots = this.parseSchedule(inst.schedule);
        const noTime = !slots.length;
        const wc = !isSel && this.wouldConflict(key, inst);
        const teacherReview = this.getReviewForTeacher(g.courseName, inst.teacher);

        const capClass = inst.bkRemaining <= 0 ? 'cap-full' : inst.bkRemaining <= 5 ? 'cap-low' : 'cap-ok';
        const capText = inst.bkRemaining <= 0 ? '已满' : `余${inst.bkRemaining}`;
        const limitTags = this._getLimitTags(inst);
        const limitTagsHTML = limitTags.map(tag => `<span class="sp-limit-tag">${tag}</span>`).join('');
        const enrollmentHTML = this._enrollmentHTML(this._getEnrollmentStats(inst), inst);

        return `
          <div class="sp-inst ${isSel ? 'is-sel' : ''} ${isConflict ? 'is-conflict' : ''} ${wc && !isSel ? 'would-conflict' : ''}" data-key="${key}">
            <div class="sp-inst-r1">
              <span class="sp-tname">${inst.teacher || '教师待定'}</span>
              <span class="sp-credits-tag">${inst.credits}学分</span>
            </div>
            ${teacherReview ? `<div style="font-size:0.8rem;color:#e6a817;margin-bottom:0.3rem;">⭐ ${teacherReview.rating.toFixed(1)} · ${teacherReview.comment_sum}条评价</div>` : ''}
            <div class="sp-inst-time ${noTime ? 'no-time' : ''}">${noTime ? '📋 时间待定' : this._formatTime(inst.schedule)}</div>
            ${enrollmentHTML}
            ${inst.bkCapacity || limitTagsHTML ? `<div class="sp-cap-row">${inst.bkCapacity ? `<span class="${capClass}">${capText}/${inst.bkCapacity}</span>` : ''}${limitTagsHTML}</div>` : ''}
            ${isConflict ? '<div class="sp-conflict-warn">⚠️ 与已选课程时间冲突</div>' : ''}
            ${wc && !isSel ? '<div class="sp-would-warn">⚠️ 加入后将产生冲突</div>' : ''}
            <div class="sp-inst-btns">
              ${isSel
                ? `<button class="sp-btn remove" data-action="remove" data-key="${key}">移除课表</button>`
                : `<button class="sp-btn add" data-action="add" data-key="${key}" data-cid="${inst.courseId}" data-seq="${inst.courseSeq}">加入课表</button>`
              }
              <button class="sp-btn review" data-action="review" data-cname="${encodeURIComponent(g.courseName)}" data-teacher="${encodeURIComponent(inst.teacher || '')}">查看评价</button>
            </div>
          </div>`;
      }).join('');

      return `
        ${sectionHTML}
        ${searchSectionHTML}
        <div class="sp-cgroup ${anySelected ? 'has-selected' : ''}" data-gid="${g.courseId}">
          <div class="sp-cgroup-hd" data-toggle="${g.courseId}">
            <div class="sp-color-dot" style="background:${color}"></div>
            <div class="sp-cname-wrap">
              <span class="sp-cname">${g.courseName}</span>
              <span class="sp-cid">${g.courseId}</span>
            </div>
            <div class="sp-cmeta">
              ${typeTagHTML}
              ${reviewTagHTML}
              <span class="sp-ccount">${g.instances.length}班</span>
              ${anySelected ? '<span class="sp-ctag">已选</span>' : ''}
              <span class="sp-chevron" id="chv-${g.courseId}">▾</span>
            </div>
          </div>
          <div class="sp-insts" id="insts-${g.courseId}">${instancesHTML}</div>
        </div>`;
    }).join('');
  }

  _formatTime(str) {
    if (!str) return '';
    return str.split(',').map(p => {
      p = p.trim();
      const m = p.match(/^(\d+)-(\d+)\(([^)]+)\)$/);
      if (!m) return p;
      const day = this.DAYS[+m[1] - 1] || `第${m[1]}天`;
      const pd = this.PERIODS.find(x => x.id === +m[2]);
      const pdStr = pd ? `${pd.label}(${pd.time})` : `第${m[2]}节`;
      const q = m[3] === '全周' ? '' : `[${m[3]}]`;
      return `${day} ${pdStr}${q}`;
    }).join('<br>');
  }

  // ==================== 统计栏 ====================
  _statsHTML() {
    const total = this.selectedCourses.size;
    const credits = Array.from(this.selectedCourses.values()).reduce((s, c) => s + (c.credits || 0), 0);
    const conflicts = this.detectConflicts();
    const hasConflict = conflicts.size > 0;
    return `
      <div class="sp-stats-bar">
        <div class="sp-stat"><span class="sp-stat-val">${total}</span><span class="sp-stat-label">门课程</span></div>
        <div class="sp-stat"><span class="sp-stat-val">${credits}</span><span class="sp-stat-label">学分</span></div>
        <div class="sp-stat ${hasConflict ? 'conflict' : 'ok'}">
          <span class="sp-stat-val">${hasConflict ? conflicts.size : '✓'}</span>
          <span class="sp-stat-label">${hasConflict ? '冲突课程' : '无冲突'}</span>
        </div>
        <div class="sp-stat-actions">
          <button class="sp-act-btn" id="spClearBtn">清空课表</button>
          <button class="sp-act-btn primary" id="spExportBtn">导出方案</button>
        </div>
      </div>`;
  }

  // ==================== 课表 HTML ====================
  _timetableHTML() {
    const conflicts = this.detectConflicts();

    // grid[day1-7][row0-13] = 课程信息数组
    const grid = {};
    for (let d = 1; d <= 7; d++) { grid[d] = {}; for (let r = 0; r < this.TOTAL_ROWS; r++) grid[d][r] = []; }

    for (const [key, course] of this.selectedCourses) {
      const slots = this.parseSchedule(course.schedule);
      const color = this._getColor(course.courseId);
      const hasConf = conflicts.has(key);
      for (const slot of slots) {
        if (slot.day < 1 || slot.day > 7) continue;
        const pd = this.PERIODS.find(p => p.id === slot.period);
        if (!pd) continue;
        grid[slot.day][pd.startRow].push({ course, key, color, hasConf, slot, pd });
      }
    }

    // 构建表头
    const thCells = this.DAYS.map((d, i) =>
      `<th class="${i >= 5 ? 'weekend' : ''}">${d}</th>`
    ).join('');

    // 构建 tbody
    // 策略：逐行遍历，时间列用 rowspan，课程格用 rowspan
    // 对每一大节生成一组行
    let tbodyHTML = '';
    for (const pd of this.PERIODS) {
      // 该节次占 pd.rows 行
      // 时间列 rowspan=pd.rows
      for (let ri = 0; ri < pd.rows; ri++) {
        tbodyHTML += '<tr>';
        // 时间列只在该节第一行输出
        if (ri === 0) {
          tbodyHTML += `<td class="sp-tt-timecell" rowspan="${pd.rows}">
            <span class="sp-period-lbl">${pd.label}</span>
            <span class="sp-period-t">${pd.time}</span>
          </td>`;
        }
        // 7天
        for (let day = 1; day <= 7; day++) {
          const rowAbs = pd.startRow + ri;
          const items = grid[day][rowAbs];

          if (items.length > 0 && ri === 0) {
            // 课程格：rowspan = 该节次行数
            if (items.length === 1) {
              const it = items[0];
              tbodyHTML += `<td class="sp-tt-cell ${day >= 6 ? 'weekend' : ''}" rowspan="${pd.rows}">
                <div class="sp-block ${it.hasConf ? 'conflicting' : ''}" style="background:${it.color}" data-key="${it.key}">
                  <div class="sp-bname">${it.course.courseName}</div>
                  <div class="sp-bteacher">${it.course.teacher || ''}</div>
                  <div class="sp-bqualifier">${it.slot.qualifier !== '全周' ? '[' + it.slot.qualifier + ']' : ''}</div>
                  ${it.hasConf ? '<span class="sp-bconflict">⚠️</span>' : ''}
                </div>
              </td>`;
            } else {
              // 冲突：多个课叠加
              const blocksHTML = items.map(it =>
                `<div class="sp-block conflicting" style="background:${it.color};flex:1;min-height:0" data-key="${it.key}">
                  <div class="sp-bname">${it.course.courseName}</div>
                  <div class="sp-bteacher">${it.course.teacher || ''}</div>
                  <span class="sp-bconflict">⚠️</span>
                </div>`
              ).join('');
              tbodyHTML += `<td class="sp-tt-cell ${day >= 6 ? 'weekend' : ''}" rowspan="${pd.rows}" style="display:table-cell">
                <div style="display:flex;flex-direction:column;height:100%;gap:2px">${blocksHTML}</div>
              </td>`;
            }
          } else if (items.length === 0 && ri === 0) {
            // 空格，需要 rowspan
            tbodyHTML += `<td class="sp-tt-cell ${day >= 6 ? 'weekend' : ''}" rowspan="${pd.rows}"></td>`;
          }
          // ri > 0 的行，时间列和课程格都已用 rowspan 覆盖，不输出 td
        }
        tbodyHTML += '</tr>';
      }
    }

    return `
      <div class="sp-tt-card">
        <table class="sp-tt">
          <thead><tr>
            <th></th>${thCells}
          </tr></thead>
          <tbody>${tbodyHTML}</tbody>
        </table>
      </div>`;
  }

  // ==================== 时间待定 ====================
  _noTimeHTML() {
    const noTime = [];
    for (const [key, c] of this.selectedCourses) {
      const slots = this.parseSchedule(c.schedule);
      if (!slots.length) noTime.push({ key, c });
    }
    if (!noTime.length) return '';
    return `
      <div class="sp-no-time">
        <div class="sp-no-time-title">📋 时间待定课程</div>
        ${noTime.map(({ key, c }) => `
          <div class="sp-nt-item" style="border-left-color:${this._getColor(c.courseId)}">
            <span class="sp-nt-name">${c.courseName}</span>
            <span class="sp-nt-teacher">${c.teacher || ''}</span>
            <span class="sp-nt-credits">${c.credits}学分</span>
            <button class="sp-nt-rm" data-key="${key}">×</button>
          </div>`).join('')}
      </div>`;
  }

  // ==================== 志愿填报 ====================
  _preferencePlanHTML() {
    this._syncPreferencePlan();
    const sections = this.preferenceTypes.map(type => {
      const items = Array.from(this.selectedCourses.entries())
        .map(([key, course]) => ({ key, course, pref: this._getCoursePreference(course) }))
        .filter(item => item.pref.typeKey === type.key)
        .sort((a, b) => {
          if (a.pref.rank !== b.pref.rank) return a.pref.rank - b.pref.rank;
          const nameCmp = String(a.course.courseName || '').localeCompare(String(b.course.courseName || ''), 'zh-CN');
          if (nameCmp !== 0) return nameCmp;
          return String(a.course.courseSeq || '').localeCompare(String(b.course.courseSeq || ''), 'zh-CN');
        });
      if (!items.length) return '';

      const rowsHTML = items.map(({ key, course, pref }) => {
        const rank = this._rankLabel(pref.rank);
        const rankClass = this._rankClass(pref.rank);
        const color = this._getColor(course.courseId);
        const stats = this._getEnrollmentStats(course);
        const probability = this._admissionProbability(course, stats);
        const prefStatsHTML = this._preferenceStatsMatrixHTML(stats, pref);
        const capacityHTML = this._capacityHTML(stats);
        const teacher = course.teacher || '教师待定';
        const meta = [
          `课序 ${course.courseSeq || '-'}`,
          teacher,
          course.schedule || '时间待定',
        ].filter(Boolean).join(' · ');
        const rankButtonsHTML = [1, 2, 3].map(rankValue => {
          const disabled = rankValue === pref.rank || !this._canSetPreference(key, type.key, rankValue);
          return `<button class="sp-pref-rank-btn ${rankValue === pref.rank ? 'active' : ''}" data-type="${type.key}" data-key="${key}" data-rank="${rankValue}" ${disabled ? 'disabled' : ''}>${rankValue}</button>`;
        }).join('');
        const probabilityHTML = probability
          ? `<span class="sp-pref-prob ${probability.className}">预计 ${probability.text}</span>`
          : `<span class="sp-pref-prob muted">暂无人数</span>`;

        return `
          <div class="sp-pref-item" style="--course-color:${color}">
            <span class="sp-pref-rank ${rankClass}">${rank}</span>
            <div class="sp-pref-course">
              <div class="sp-pref-name">${course.courseName}</div>
              <div class="sp-pref-meta">${meta}</div>
            </div>
            <div class="sp-pref-side">
              ${capacityHTML}
              ${prefStatsHTML}
            </div>
            ${probabilityHTML}
            <div class="sp-pref-actions">
              ${rankButtonsHTML}
            </div>
          </div>`;
      }).join('');

      const first = items.filter(item => item.pref.rank === 1).length;
      const second = items.filter(item => item.pref.rank === 2).length;
      const third = items.filter(item => item.pref.rank === 3).length;
      return `
        <div class="sp-pref-section" style="--type-color:${type.color}">
          <div class="sp-pref-section-title">
            <span>${type.label}</span>
            <span class="sp-pref-count">一 ${first}/1 · 二 ${second}/2 · 三 ${third}</span>
          </div>
          <div class="sp-pref-items">${rowsHTML}</div>
        </div>`;
    }).filter(Boolean).join('');

    if (!sections) return '';
    return `
      <div class="sp-pref-plan">
        <div class="sp-pref-plan-title">已选课程志愿填报情况</div>
        ${sections}
      </div>`;
  }

  // ==================== 事件绑定 ====================
  _bindEvents() {
    // 视图切换
    document.querySelectorAll('.sp-vtab').forEach(btn => {
      btn.addEventListener('click', () => {
        this.currentView = btn.dataset.view;
        this.render();
      });
    });

    // 搜索
    const searchEl = document.getElementById('spSearch');
    if (searchEl) {
      searchEl.addEventListener('input', e => {
        this.searchQuery = e.target.value;
        document.getElementById('spList').innerHTML = this._courseListHTML();
        this._bindListEvents();
      });
    }

    const searchGroupEl = document.getElementById('spSearchGroupFilter');
    if (searchGroupEl) {
      searchGroupEl.addEventListener('change', e => {
        this.searchGroupFilter = e.target.value;
        document.getElementById('spList').innerHTML = this._courseListHTML();
        this._bindListEvents();
      });
    }

    // 类型筛选
    const filterEl = document.getElementById('spTypeFilter');
    if (filterEl) {
      filterEl.addEventListener('change', e => {
        this.filterType = e.target.value;
        document.getElementById('spList').innerHTML = this._courseListHTML();
        this._bindListEvents();
      });
    }

    this._bindListEvents();
  }

  _bindListEvents() {
    // 展开/收起课程组
    document.querySelectorAll('[data-toggle]').forEach(el => {
      el.addEventListener('click', () => {
        const cid = el.dataset.toggle;
        const insts = document.getElementById(`insts-${cid}`);
        const chv = document.getElementById(`chv-${cid}`);
        if (!insts) return;
        const open = insts.classList.toggle('open');
        if (chv) chv.classList.toggle('open', open);
      });
    });

    // 加入/移除/查看评价
    document.querySelectorAll('[data-action]').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const action = btn.dataset.action;
        if (action === 'add') {
          this._addCourse(btn.dataset.key, btn.dataset.cid, btn.dataset.seq);
        } else if (action === 'remove') {
          this._removeCourse(btn.dataset.key);
        } else if (action === 'review') {
          this._showReviewModal(
            decodeURIComponent(btn.dataset.cname),
            decodeURIComponent(btn.dataset.teacher)
          );
        }
      });
    });
  }

  _addCourse(key, courseId, courseSeq) {
    if (!this.scheduleData?.data) return;
    const c = this.scheduleData.data.find(x => x.courseId === courseId && x.courseSeq === courseSeq);
    if (!c) return;
    this.selectedKeys.add(key);
    this.selectedCourses.set(key, c);
    this._getColor(c.courseId);
    this._save();
    this.render();
  }

  _removeCourse(key) {
    this.selectedKeys.delete(key);
    this.selectedCourses.delete(key);
    this._save();
    this.render();
  }

  // ==================== 评价弹窗 ====================
  _showReviewModal(courseName, teacherName) {
    const allReviews = this.getReviewsForCourse(courseName);
    let reviews = teacherName
      ? allReviews.filter(r => r.course_teacher === teacherName)
      : allReviews;

    document.getElementById('modalCourseTitle').textContent = courseName;
    document.getElementById('modalCourseId').textContent = teacherName || '';
    document.getElementById('modalCourseInfo').innerHTML = '';

    if (!reviews.length) {
      document.getElementById('modalComments').innerHTML = `
        <div style="text-align:center;padding:2rem;color:#999;">
          <div style="font-size:2.5rem;margin-bottom:1rem;">📝</div>
          <p>暂无评价数据</p>
          <p style="font-size:0.85rem;margin-top:0.5rem;">${teacherName ? '该教师暂无评价' : '点击「更新选课评价」获取最新数据'}</p>
        </div>`;
    } else {
      document.getElementById('modalComments').innerHTML = reviews.map(rv => `
        <div style="margin-bottom:1.5rem;padding:1.2rem;background:#f9f9f9;border-radius:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem;padding-bottom:0.75rem;border-bottom:1px solid #e0e0e0;">
            <strong style="font-size:1rem;">👨‍🏫 ${rv.course_teacher}</strong>
            <span style="color:#FFC107;font-size:1.2rem;font-weight:bold;">⭐ ${rv.rating.toFixed(1)}</span>
          </div>
          <div style="color:#666;font-size:0.85rem;margin-bottom:0.75rem;">共 ${rv.comment_sum} 条评价</div>
          ${rv.comments.slice(0, 8).map(cm => cm ? `
            <div class="comment-item">
              <div style="font-size:0.9rem;line-height:1.6;">${cm}</div>
            </div>` : '').join('')}
          ${rv.comments.length > 8 ? `<div style="text-align:center;color:#999;font-size:0.85rem;margin-top:0.5rem;">还有 ${rv.comments.length - 8} 条评价…</div>` : ''}
        </div>`).join('');
    }

    document.getElementById('courseModal').classList.add('show');
  }

  // ==================== 导出 ====================
  _exportPlan() {
    const conflicts = this.detectConflicts();
    const courses = Array.from(this.selectedCourses.values());
    let txt = `下学期选课方案\n生成时间：${new Date().toLocaleString('zh-CN')}\n${'='.repeat(50)}\n\n`;
    txt += `共 ${courses.length} 门课程，${courses.reduce((s, c) => s + c.credits, 0)} 学分\n`;
    if (conflicts.size) txt += `⚠️ 存在 ${conflicts.size} 门冲突课程，请检查！\n`;
    txt += '\n';
    courses.forEach((c, i) => {
      const key = `${c.courseId}::${c.courseSeq}`;
      txt += `${i+1}. ${c.courseName}${conflicts.has(key) ? ' ⚠️[冲突]' : ''}\n`;
      txt += `   课程号：${c.courseId} | 教师：${c.teacher || '待定'} | 学分：${c.credits}\n`;
      txt += `   时间：${c.schedule || '待定'}\n\n`;
    });
    const blob = new Blob([txt], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `选课方案_${Date.now()}.txt`;
    a.click(); URL.revokeObjectURL(url);
  }
}

if (typeof window !== 'undefined') window.SchedulePlanner = SchedulePlanner;
