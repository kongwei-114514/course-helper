/**
 * Course Helper Dashboard
 * 主界面逻辑控制
 */

class Dashboard {
  constructor() {
    this.trainingPlanData = null;
    this.courseReviewsData = null;
    this.currentFilter = 'all';
    this.selectedGroup = null;
    
    this.init();
  }

  async init() {
    console.log('Dashboard initializing...');
    
    // 绑定事件
    this.bindEvents();
    
    // 加载数据
    await this.loadData();
    
    // 渲染界面
    this.render();
  }

  bindEvents() {
    // 更新按钮
    document.getElementById('refreshTrainingPlan').addEventListener('click', () => {
      this.refreshTrainingPlan();
    });

    document.getElementById('refreshReviews').addEventListener('click', () => {
      this.refreshReviews();
    });

    document.getElementById('exportData').addEventListener('click', () => {
      this.exportData();
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

    // 模态框关闭
    document.getElementById('modalClose').addEventListener('click', () => {
      document.getElementById('courseModal').classList.remove('show');
    });

    document.getElementById('courseModal').addEventListener('click', (e) => {
      if (e.target.id === 'courseModal') {
        document.getElementById('courseModal').classList.remove('show');
      }
    });
  }

  async loadData() {
    // 从 storage 加载数据
    const [trainingPlan, reviews] = await Promise.all([
      this.loadTrainingPlan(),
      this.loadCourseReviews()
    ]);

    this.trainingPlanData = trainingPlan;
    this.courseReviewsData = reviews;

    console.log('Data loaded:', { 
      hasTrainingPlan: !!trainingPlan, 
      reviewsCount: reviews?.courses?.length || 0 
    });
  }

  loadTrainingPlan() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'LOAD_TRAINING_PLAN' }, (res) => {
        resolve(res?.data || null);
      });
    });
  }

  loadCourseReviews() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'LOAD_COURSE_REVIEWS' }, (res) => {
        resolve(res?.data || null);
      });
    });
  }

  async refreshTrainingPlan() {
    const btn = document.getElementById('refreshTrainingPlan');
    btn.disabled = true;
    btn.textContent = '⏳ 更新中...';

    try {
      // 获取 HTML
      const response = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'FETCH_TRAINING_PLAN_HTML' }, resolve);
      });

      if (!response.success) {
        throw new Error(response.error || '获取失败');
      }

      // 解析数据
      const parser = new TrainingPlanParser(response.html);
      const parsedData = parser.parse();

      // 分析数据
      const analyzer = new TrainingPlanAnalyzer(parsedData);
      const report = analyzer.generateReport();
      const recommendations = analyzer.generateRecommendations(report);

      const data = { report, recommendations, parsedData };

      // 保存数据
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({ 
          type: 'SAVE_TRAINING_PLAN', 
          data 
        }, resolve);
      });

      this.trainingPlanData = data;
      this.render();

      alert('✅ 培养方案数据已更新！');

    } catch (error) {
      console.error('刷新培养方案失败:', error);
      alert('❌ 更新失败: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '🔄 更新培养方案';
    }
  }

  async refreshReviews() {
    const btn = document.getElementById('refreshReviews');
    btn.disabled = true;

    try {
      // 检查本地数据
      const localData = this.courseReviewsData;
      const localCount = localData?.totalCount || 0;

      // 获取远程总数
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

      // 需要更新
      const newReviewsCount = remoteCount - localCount;
      const pagesToFetch = Math.ceil(newReviewsCount / 20);

      btn.textContent = `⏳ 更新中 (0/${pagesToFetch})`;

      const newReviews = [];
      newReviews.push(...firstPage.results);

      // 获取新增的评价
      for (let page = 2; page <= pagesToFetch; page++) {
        await this.sleep(400);
        const res = await fetch(`https://yourschool.cc/thucourse_api/api/review/?page=${page}&size=20`);
        const data = await res.json();
        newReviews.push(...data.results);
        btn.textContent = `⏳ 更新中 (${page}/${pagesToFetch})`;
      }

      // 处理数据
      const courseMap = new Map();
      
      // 先加载本地数据
      if (localData?.courses) {
        localData.courses.forEach(c => courseMap.set(c.course_id, c));
      }

      // 合并新数据
      newReviews.forEach(item => {
        const courseId = item.course.id;
        
        if (!courseMap.has(courseId)) {
          courseMap.set(courseId, {
            course_name: item.course.name,
            course_teacher: item.course.teacher,
            course_id: courseId,
            rating: item.rating,
            comments: [item.comment],
            comment_sum: 1
          });
        } else {
          const course = courseMap.get(courseId);
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

      // 保存数据
      await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'SAVE_COURSE_REVIEWS',
          data: updatedData
        }, resolve);
      });

      this.courseReviewsData = updatedData;
      this.render();

      alert(`✅ 已更新 ${newReviewsCount} 条新评价！`);

    } catch (error) {
      console.error('刷新评价失败:', error);
      alert('❌ 更新失败: ' + error.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '📊 更新选课评价';
    }
  }

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

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
    alert('✅ 数据已导出！');
  }

  render() {
    this.renderStats();
    this.renderGroupList();
  }

  renderStats() {
    if (!this.trainingPlanData) {
      return;
    }

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
        </div>
      `;
      return;
    }

    const { report } = this.trainingPlanData;
    const allGroups = [
      ...report.byType.required.groups.map(g => ({ ...g, type: 'required' })),
      ...report.byType.elective.groups.map(g => ({ ...g, type: 'elective' })),
      ...report.byType.optional.groups.map(g => ({ ...g, type: 'optional' }))
    ];

    // 筛选
    let filtered = allGroups;
    if (this.currentFilter === 'incomplete') {
      filtered = allGroups.filter(g => !g.isCompleted);
    } else if (this.currentFilter === 'required') {
      filtered = allGroups.filter(g => g.type === 'required');
    } else if (this.currentFilter === 'elective') {
      filtered = allGroups.filter(g => g.type === 'elective');
    }

    if (filtered.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 2rem; color: #999;">
          <p>无符合条件的课程组</p>
        </div>
      `;
      return;
    }

    container.innerHTML = filtered.map(group => `
      <div class="group-item ${group.isCompleted ? 'completed' : ''}" 
           data-group-name="${group.groupName}">
        <div class="group-name">
          <span>${group.groupName}</span>
          <span class="badge ${group.isCompleted ? 'badge-success' : 'badge-warning'}">
            ${group.isCompleted ? '✓' : group.remainingCredits + '学分'}
          </span>
        </div>
        <div class="group-progress">
          ${group.completedCredits}/${group.requiredCredits} 学分 · 
          ${group.completedCourses}/${group.requiredCourses} 门课
        </div>
      </div>
    `).join('');

    // 绑定点击事件
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
    
    // 获取未修课程
    const incompleteCourses = group.incompleteCourseList || [];

    if (incompleteCourses.length === 0) {
      container.innerHTML = `
        <div style="text-align: center; padding: 3rem; color: #999;">
          <div style="font-size: 3rem; margin-bottom: 1rem;">✅</div>
          <h3>该课程组已完成</h3>
          <p style="margin-top: 0.5rem;">所有必修课程已完成</p>
        </div>
      `;
      return;
    }

    // 渲染课程卡片
    container.innerHTML = incompleteCourses.map(course => {
      const review = this.getCourseReview(course.courseId, course.courseName);
      
      return `
        <div class="course-card" data-course-id="${course.courseId}">
          <div class="course-header">
            <div>
              <div class="course-title">${course.courseName}</div>
              <div class="course-id">${course.courseId}</div>
            </div>
            ${review ? `
              <div class="course-rating">
                <span>⭐</span>
                <span>${review.rating.toFixed(1)}</span>
              </div>
            ` : ''}
          </div>
          <div class="course-info">
            <div class="course-info-item">
              <span>📚</span>
              <span>${course.credits} 学分</span>
            </div>
            ${review ? `
              <div class="course-info-item">
                <span>💬</span>
                <span>${review.comment_sum} 条评价</span>
              </div>
              ${review.course_teacher ? `
                <div class="course-info-item">
                  <span>👨‍🏫</span>
                  <span>${review.course_teacher}</span>
                </div>
              ` : ''}
            ` : `
              <div class="course-info-item" style="color: #999;">
                <span>ℹ️</span>
                <span>暂无评价</span>
              </div>
            `}
          </div>
        </div>
      `;
    }).join('');

    // 绑定点击事件
    container.querySelectorAll('.course-card').forEach(card => {
      card.addEventListener('click', () => {
        const courseId = card.dataset.courseId;
        const course = incompleteCourses.find(c => c.courseId === courseId);
        this.showCourseModal(course);
      });
    });
  }

  getCourseReview(courseId, courseName) {
    if (!this.courseReviewsData?.courses) {
      return null;
    }

    // 先尝试按课程号匹配
    let review = this.courseReviewsData.courses.find(c => c.course_id === courseId);
    
    // 如果没找到，尝试按课程名匹配
    if (!review) {
      review = this.courseReviewsData.courses.find(c => 
        c.course_name.includes(courseName) || courseName.includes(c.course_name)
      );
    }

    return review;
  }

  showCourseModal(course) {
    const review = this.getCourseReview(course.courseId, course.courseName);
    
    document.getElementById('modalCourseTitle').textContent = course.courseName;
    document.getElementById('modalCourseId').textContent = course.courseId;

    const infoHtml = `
      <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 1rem; margin-bottom: 1.5rem;">
        <div>
          <div style="color: #666; font-size: 0.9rem;">学分</div>
          <div style="font-weight: bold; margin-top: 0.3rem;">${course.credits}</div>
        </div>
        ${review ? `
          <div>
            <div style="color: #666; font-size: 0.9rem;">平均评分</div>
            <div style="font-weight: bold; margin-top: 0.3rem; color: #FFC107;">
              ⭐ ${review.rating.toFixed(1)}
            </div>
          </div>
          ${review.course_teacher ? `
            <div>
              <div style="color: #666; font-size: 0.9rem;">教师</div>
              <div style="font-weight: bold; margin-top: 0.3rem;">${review.course_teacher}</div>
            </div>
          ` : ''}
          <div>
            <div style="color: #666; font-size: 0.9rem;">评价数量</div>
            <div style="font-weight: bold; margin-top: 0.3rem;">${review.comment_sum}</div>
          </div>
        ` : ''}
      </div>
    `;

    document.getElementById('modalCourseInfo').innerHTML = infoHtml;

    const commentsHtml = review?.comments?.length > 0 ? `
      <h3 style="margin-bottom: 1rem;">学生评价</h3>
      ${review.comments.slice(0, 10).map(comment => `
        <div class="comment-item">
          <div class="comment-text">${comment}</div>
        </div>
      `).join('')}
      ${review.comments.length > 10 ? `
        <div style="text-align: center; color: #999; margin-top: 1rem;">
          还有 ${review.comments.length - 10} 条评价未显示
        </div>
      ` : ''}
    ` : `
      <div style="text-align: center; color: #999; padding: 2rem;">
        暂无评价数据
      </div>
    `;

    document.getElementById('modalComments').innerHTML = commentsHtml;
    document.getElementById('courseModal').classList.add('show');
  }
}

// 初始化
const dashboard = new Dashboard();