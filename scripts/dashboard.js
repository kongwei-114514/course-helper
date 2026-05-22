/**
 * Course Helper Dashboard v3
 * 培养方案逻辑原版保留，新增选课规划页切换
 */

class Dashboard {
  constructor() {
    this.trainingPlanData = null;
    this.courseReviewsData = null;
    this.currentFilter = 'all';
    this.selectedGroup = null;
    this.schedulePlanner = null;
    this.scheduleInited = false;

    this.init();
  }

  async init() {
    console.log('Dashboard initializing...');
    this.bindPageTabs();
    this.bindEvents();
    await this.loadData();
    this.render();
  }

  // ==================== 页面切换 ====================
  bindPageTabs() {
    document.querySelectorAll('.page-tab').forEach(tab => {
      tab.addEventListener('click', async e => {
        document.querySelectorAll('.page-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        e.currentTarget.classList.add('active');
        const page = e.currentTarget.dataset.page;
        document.getElementById(`page-${page}`)?.classList.add('active');

        // 首次进入选课页才初始化
        if (page === 'schedule' && !this.scheduleInited) {
          this.scheduleInited = true;
          await this.initSchedulePlanner();
        }
      });
    });
  }

  async initSchedulePlanner() {
    this.schedulePlanner = new SchedulePlanner(this.courseReviewsData);
    await this.schedulePlanner.loadData();
    this.schedulePlanner.render();

    // 模态框关闭（选课评价弹窗复用培养方案的模态框）
    document.getElementById('modalClose')?.addEventListener('click', () => {
      document.getElementById('courseModal')?.classList.remove('show');
    });
    document.getElementById('courseModal')?.addEventListener('click', e => {
      if (e.target.id === 'courseModal') e.target.classList.remove('show');
    });
  }

  // ==================== 原版事件绑定（完整保留）====================
  bindEvents() {
    document.getElementById('refreshTrainingPlan').addEventListener('click', () => {
      this.refreshTrainingPlan();
    });

    document.getElementById('refreshReviews').addEventListener('click', () => {
      this.refreshReviews();
    });

    document.getElementById('exportData').addEventListener('click', () => {
      this.exportData();
    });

    document.getElementById('xuankeshequ').addEventListener('click', () => {
      this.xuankeshequ();
    });

    // 筛选标签
    document.querySelectorAll('.filter-tabs .tab').forEach(tab => {
      tab.addEventListener('click', (e) => {
        document.querySelectorAll('.filter-tabs .tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');
        this.currentFilter = e.target.dataset.filter;
        this.renderGroupList();
      });
    });

    // 模态框关闭（培养方案用）
    document.getElementById('modalClose').addEventListener('click', () => {
      document.getElementById('courseModal').classList.remove('show');
    });

    document.getElementById('courseModal').addEventListener('click', (e) => {
      if (e.target.id === 'courseModal') {
        document.getElementById('courseModal').classList.remove('show');
      }
    });
  }

  // ==================== 原版数据加载 ====================
  async loadData() {
    const [trainingPlan, reviews] = await Promise.all([
      this.loadTrainingPlan(),
      this.loadCourseReviews()
    ]);
    this.trainingPlanData = trainingPlan;
    this.courseReviewsData = reviews;
    console.log('Data loaded from Chrome Storage:', {
      hasTrainingPlan: !!trainingPlan,
      reviewsCount: reviews?.courses?.length || 0
    });
  }

  loadTrainingPlan() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['trainingPlanData'], (result) => {
        resolve(result.trainingPlanData || null);
      });
    });
  }

  loadCourseReviews() {
    return new Promise((resolve) => {
      chrome.storage.local.get(['courseReviewsData'], (result) => {
        resolve(result.courseReviewsData || null);
      });
    });
  }

  // ==================== 原版刷新培养方案 ====================
  async refreshTrainingPlan() {
    const btn = document.getElementById('refreshTrainingPlan');
    btn.disabled = true;
    btn.textContent = '⏳ 更新中...';

    try {
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_TRAINING_PLAN_HTML' }, resolve);
      });

      if (!response.success) throw new Error(response.error || '获取失败');

      const parser = new TrainingPlanParser(response.html);
      const parsedData = parser.parse();
      const analyzer = new TrainingPlanAnalyzer(parsedData);
      const report = analyzer.generateReport();
      const recommendations = analyzer.generateRecommendations(report);
      const data = { report, recommendations, parsedData };

      await new Promise((resolve) => {
        chrome.storage.local.set({ trainingPlanData: data }, () => {
          console.log('培养方案数据已保存到Chrome Storage');
          resolve();
        });
      });

      this.trainingPlanData = data;
      this.render();
      alert('✅ 培养方案数据已更新并保存！\n\n数据已自动保存在浏览器本地，关闭浏览器也不会丢失。');

    } catch (error) {
      console.error('刷新培养方案失败:', error);
      alert('❌ 更新失败: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 更新培养方案';
    }
  }

  // ==================== 原版刷新评价 ====================
  async refreshReviews() {
    const btn = document.getElementById('refreshReviews');
    btn.disabled = true;

    try {
      const localData = this.courseReviewsData;
      const localCount = localData?.totalCount || 0;

      const response = await fetch('https://yourschool.cc/thucourse_api/api/review/?page=1&size=20');
      const firstPage = await response.json();
      const remoteCount = firstPage.count || 0;

      console.log('评价数量对比:', { local: localCount, remote: remoteCount });

      if (remoteCount <= localCount) {
        alert('ℹ️ 评价数据已是最新，无需更新');
        btn.disabled = false;
        btn.textContent = '📊 更新选课评价';
        return;
      }

      const totalPages = Math.ceil(remoteCount / 20);
      btn.textContent = `⏳ 更新中 (1/${totalPages})`;

      const allReviews = [];
      allReviews.push(...firstPage.results);

      for (let page = 2; page <= totalPages; page++) {
        await this.sleep(400);
        const res = await fetch(`https://yourschool.cc/thucourse_api/api/review/?page=${page}&size=20`);
        const data = await res.json();

        if (data.detail && data.detail.includes('限速')) {
          console.log(`Page ${page} rate limited, retrying...`);
          await this.sleep(1000);
          page--;
          continue;
        }

        if (data.results) allReviews.push(...data.results);
        btn.textContent = `⏳ 更新中 (${page}/${totalPages})`;
      }

      const courseMap = new Map();
      allReviews.forEach(item => {
        const courseKey = `${item.course.name}|||${item.course.teacher}`;
        if (!courseMap.has(courseKey)) {
          courseMap.set(courseKey, {
            course_name: item.course.name,
            course_teacher: item.course.teacher,
            course_id: item.course.id,
            rating: item.rating,
            comments: [item.comment],
            comment_sum: 1
          });
        } else {
          const course = courseMap.get(courseKey);
          const newCommentSum = course.comment_sum + 1;
          course.rating = (course.rating * course.comment_sum + item.rating) / newCommentSum;
          course.comments.push(item.comment);
          course.comment_sum = newCommentSum;
        }
      });

      const updatedData = {
        courses: Array.from(courseMap.values()),
        lastUpdate: Date.now(),
        totalCount: remoteCount
      };

      await new Promise((resolve) => {
        chrome.storage.local.set({ courseReviewsData: updatedData }, () => {
          console.log('课程评价数据已保存到Chrome Storage');
          resolve();
        });
      });

      this.courseReviewsData = updatedData;
      // 同步给已初始化的选课规划器
      if (this.schedulePlanner) this.schedulePlanner.reviewsData = updatedData;
      this.render();
      alert(`✅ 已更新评价数据！\n\n共 ${updatedData.courses.length} 门课程（包含不同教师）\n数据已自动保存，关闭浏览器不会丢失。`);

    } catch (error) {
      console.error('刷新评价失败:', error);
      alert('❌ 更新失败: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '📊 更新选课评价';
    }
  }

  sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

  // ==================== 原版导出 ====================
  exportData() {
    if (!this.trainingPlanData) {
      alert('请先更新培养方案数据');
      return;
    }

    const exporter = new TrainingPlanExporter(
      this.trainingPlanData.report,
      this.trainingPlanData.recommendations
    );
    exporter.exportAll();

    if (this.courseReviewsData) {
      const timestamp = new Date().toISOString().slice(0, 10);
      const jsonStr = JSON.stringify(this.courseReviewsData, null, 2);
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `课程评价数据_${timestamp}.json`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }

    alert('✅ 数据已导出到下载文件夹！\n\n💡 提示：数据已自动保存在浏览器的Chrome Storage中。\n\n即使不导出，数据也会永久保存，关闭浏览器不会丢失。\n\n导出功能主要用于备份或分享数据。');
  }

  // ==================== 原版渲染 ====================
  render() {
    this.renderStats();
    this.renderGroupList();
  }

  xuankeshequ() {
    window.open("https://yourschool.cc/thucourse/write-review", '_blank');
  }

  renderStats() {
    if (!this.trainingPlanData) return;
    const { report } = this.trainingPlanData;
    const { summary } = report;
    document.getElementById('totalRequired').textContent = summary.totalRequired;
    document.getElementById('totalCompleted').textContent = summary.totalCompleted;
    document.getElementById('totalRemaining').textContent = summary.totalRemaining;
    document.getElementById('incompleteGroups').textContent = report.incompleteGroups.length;
    const percentage = (summary.totalCompleted / summary.totalRequired * 100).toFixed(0);
    document.getElementById('completionProgress').style.width = percentage + '%';
  }

  renderGroupList() {
    const container = document.getElementById('groupList');

    if (!this.trainingPlanData) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: #999;">
          <p>暂无数据</p>
          <p style="font-size: 0.85rem; margin-top: 0.5rem;">请点击"更新培养方案"</p>
        </div>`;
      return;
    }

    const { report } = this.trainingPlanData;
    const allGroups = [
      ...report.byType.required.groups.map(g => ({ ...g, type: 'required' })),
      ...report.byType.elective.groups.map(g => ({ ...g, type: 'elective' })),
      ...report.byType.optional.groups.map(g => ({ ...g, type: 'optional' }))
    ];

    let filtered = allGroups;
    if (this.currentFilter === 'incomplete') {
      filtered = allGroups.filter(g => !g.isCompleted);
    } else if (this.currentFilter === 'required') {
      filtered = allGroups.filter(g => g.type === 'required');
    } else if (this.currentFilter === 'elective') {
      filtered = allGroups.filter(g => g.type === 'elective');
    }

    if (filtered.length === 0) {
      container.innerHTML = `<div style="text-align: center; padding: 2rem; color: #999;"><p>无符合条件的课程组</p></div>`;
      return;
    }

    container.innerHTML = filtered.map(group => `
      <div class="group-item ${group.isCompleted ? 'completed' : ''}" data-group-name="${group.groupName}">
        <div class="group-name">
          <span>${group.groupName}</span>
          <span class="badge ${group.isCompleted ? 'badge-success' : 'badge-warning'}">
            ${group.isCompleted ? '✓' : group.remainingCredits + '学分'}
          </span>
        </div>
        <div class="group-progress">
          ${group.completedCredits}/${group.requiredCredits} 学分 · ${group.completedCourses}/${group.requiredCourses} 门课
        </div>
      </div>`).join('');

    container.querySelectorAll('.group-item').forEach(item => {
      item.addEventListener('click', () => {
        container.querySelectorAll('.group-item').forEach(i => i.classList.remove('active'));
        item.classList.add('active');
        const groupName = item.dataset.groupName;
        const group = allGroups.find(g => g.groupName === groupName);
        this.showGroupDetail(group);
      });
    });
  }

  showGroupDetail(group) {
    this.selectedGroup = group;
    document.getElementById('emptyState').style.display = 'none';
    document.getElementById('courseDetail').style.display = 'block';
    document.getElementById('groupTitle').textContent = group.groupName;

    const container = document.getElementById('courseGrid');
    const incompleteCourses = group.incompleteCourseList || [];

    if (incompleteCourses.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem; color: #999;">
          <div style="font-size: 3rem; margin-bottom: 1rem;">✅</div>
          <h3>该课程组已完成</h3>
          <p style="margin-top: 0.5rem;">所有必修课程已完成</p>
        </div>`;
      return;
    }

    const coursesByName = new Map();
    incompleteCourses.forEach(course => {
      if (!coursesByName.has(course.courseName)) coursesByName.set(course.courseName, course);
    });

    container.innerHTML = Array.from(coursesByName.values()).map(course => {
      const teacherReviews = this.getCourseReviewsByName(course.courseName);
      return `
        <div class="course-card" data-course-id="${course.courseId}" data-course-name="${course.courseName}">
          <div class="course-header">
            <div>
              <div class="course-title">${course.courseName}</div>
              <div class="course-id">${course.courseId}</div>
            </div>
          </div>
          <div class="course-info">
            <div class="course-info-item"><span>📚</span><span>${course.credits} 学分</span></div>
            ${teacherReviews.length > 0
              ? `<div class="course-info-item"><span>👨‍🏫</span><span>${teacherReviews.length} 位教师</span></div>`
              : `<div class="course-info-item" style="color:#999;"><span>ℹ️</span><span>暂无评价</span></div>`}
          </div>
          ${teacherReviews.length > 0 ? `
            <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #e0e0e0;">
              <div style="font-weight:bold;margin-bottom:0.5rem;font-size:0.9rem;color:#666;">各教师评价：</div>
              ${teacherReviews.slice(0, 5).map(review => `
                <div style="display:flex;justify-content:space-between;align-items:center;padding:0.5rem 0;border-bottom:1px solid #f5f5f5;">
                  <div style="flex:1;">
                    <span style="font-weight:500;">${review.course_teacher}</span>
                    <span style="color:#999;font-size:0.85rem;margin-left:0.5rem;">${review.comment_sum} 条评价</span>
                  </div>
                  <div style="color:#FFC107;font-weight:bold;white-space:nowrap;margin-left:1rem;">⭐ ${review.rating.toFixed(1)}</div>
                </div>`).join('')}
              ${teacherReviews.length > 5 ? `<div style="text-align:center;color:#999;font-size:0.85rem;margin-top:0.5rem;">还有 ${teacherReviews.length - 5} 位教师</div>` : ''}
            </div>` : ''}
        </div>`;
    }).join('');

    container.querySelectorAll('.course-card').forEach(card => {
      card.addEventListener('click', () => {
        const courseName = card.dataset.courseName;
        const course = incompleteCourses.find(c => c.courseName === courseName);
        this.showCourseModal(course);
      });
    });
  }

  getCourseReviewsByName(courseName) {
    if (!this.courseReviewsData?.courses) return [];
    return this.courseReviewsData.courses.filter(c =>
      c.course_name.includes(courseName) || courseName.includes(c.course_name)
    ).sort((a, b) => b.rating - a.rating);
  }

  getCourseReview(courseId, courseName) {
    if (!this.courseReviewsData?.courses) return null;
    let review = this.courseReviewsData.courses.find(c => c.course_id === courseId);
    if (!review) review = this.courseReviewsData.courses.find(c =>
      c.course_name.includes(courseName) || courseName.includes(c.course_name)
    );
    return review;
  }

  showCourseModal(course) {
    const teacherReviews = this.getCourseReviewsByName(course.courseName);
    document.getElementById('modalCourseTitle').textContent = course.courseName;
    document.getElementById('modalCourseId').textContent = course.courseId;

    document.getElementById('modalCourseInfo').innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(2,1fr);gap:1rem;margin-bottom:1.5rem;">
        <div>
          <div style="color:#666;font-size:0.9rem;">学分</div>
          <div style="font-weight:bold;margin-top:0.3rem;">${course.credits}</div>
        </div>
        ${teacherReviews.length > 0 ? `
          <div>
            <div style="color:#666;font-size:0.9rem;">教师数量</div>
            <div style="font-weight:bold;margin-top:0.3rem;">${teacherReviews.length} 位</div>
          </div>` : ''}
      </div>`;

    document.getElementById('modalComments').innerHTML = teacherReviews.length > 0 ? `
      ${teacherReviews.map(review => `
        <div style="margin-bottom:2rem;padding:1.5rem;background:#f9f9f9;border-radius:8px;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:1rem;padding-bottom:1rem;border-bottom:2px solid #e0e0e0;">
            <h3 style="margin:0;font-size:1.1rem;">👨‍🏫 ${review.course_teacher}</h3>
            <div style="font-size:1.5rem;color:#FFC107;font-weight:bold;">⭐ ${review.rating.toFixed(1)}</div>
          </div>
          <div style="color:#666;font-size:0.9rem;margin-bottom:1rem;">共 ${review.comment_sum} 条评价</div>
          ${review.comments.slice(0, 5).map(comment => `
            <div class="comment-item">
              <div class="comment-text">${comment}</div>
            </div>`).join('')}
          ${review.comments.length > 5 ? `<div style="text-align:center;color:#999;margin-top:1rem;font-size:0.9rem;">还有 ${review.comments.length - 5} 条评价未显示</div>` : ''}
        </div>`).join('')}` : `
      <div style="text-align:center;color:#999;padding:2rem;">
        <div style="font-size:3rem;margin-bottom:1rem;">📝</div>
        <p>暂无评价数据</p>
        <p style="font-size:0.85rem;margin-top:0.5rem;">点击"更新选课评价"获取最新数据</p>
      </div>`;

    document.getElementById('courseModal').classList.add('show');
  }
}

// 初始化
const dashboard = new Dashboard();
window.courseHelperDashboard = dashboard;
