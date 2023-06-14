const { response, request } = require("express");
const bcrypt = require("bcryptjs");
const User = require("../models/user");
const uuidv4 = require('uuid').v4;

const { careerExistByName, CareerIdByName, getSubjectById } = require("../helpers/db-validators");

// Get all users
const usersGet = async (req = request, res = response) => {
    const filters = req.query;
    const usersFiltered = await User.find(filters);

    // Find filtered users
    const users = usersFiltered.filter(user => {
        let isValid = true;
        for (const key in filters) {
            isValid = isValid && user[key] == filters[key];
        }
        return isValid;
    })

    const total = users.length;

    res.json({
        total,
        users
    });
};

// Post a new user
const usersPost = async (req, res) => {
    const user = new User(req.body);

    // Encrypt password
    const salt = bcrypt.genSaltSync();
    user.password = bcrypt.hashSync(user.password, salt);

    // Validate career
    const careerDB = await careerExistByName(user.career);
    if (!careerDB) {
        return res.status(400).json({
            msg: `The career ${user.career} does not exist in the database`
        });
    }
    else {
        user.career_id = await CareerIdByName(user.career);
    }

    await user.save();
    res.json({
        user,
    });
};

// Patch an specific user field
const usersPatch = async (req, res = response) => {
    // Patch to add a new subject or evaluations or edit existent ones

    const { id } = req.params;
    const { subjects, evaluations } = req.body;

    // Find user
    const user = await User.findById(id);

    // Add new subject
    if (subjects) await addOrUpdateSubject(user, subjects);

    // Add new evaluation
    if (evaluations) await updateOrDeleteEvaluation(user, evaluations);

    if (req.body.password || req.body.role) await updateUser(req, user);

    // Calculate CUM
    user.cum = calculateCum(user.subjects);

    // Save updated user
    const userDB = await User.findByIdAndUpdate(id, user, { new: true });

    res.json({
        userDB,
    });
};

// Add or update a subject in the user's subjects array
async function addOrUpdateSubject(user, subjects) {
    if (!subjects) {
        return;
    }

    const existingSubject = user.subjects.find((subj) => subj.id === subjects[0].id);

    if (existingSubject) {
        if (existingSubject.failed_attempts?.length > 0) {
            subjects[0].times = existingSubject.failed_attempts.length + 1;
        }

        if (!existingSubject.approved && !existingSubject.current && !subjects[0].delete) {
            const failed_attempt = {
                times: existingSubject.times,
                average: existingSubject.average,
                evaluations: existingSubject.evaluations
            };

            existingSubject.failed_attempts = (existingSubject.failed_attempts || []).concat([failed_attempt]);
            existingSubject.times += 1;
            existingSubject.average = subjects[0].average || 0;
            existingSubject.evaluations = subjects[0].evaluations || [];
        }

        existingSubject.current = subjects[0].current;

        if (subjects[0].delete) {
            user.subjects = user.subjects.filter((subj) => subj.id !== existingSubject.id);
        }
    } else {
        const subjectData = await getSubjectById(subjects[0].id);

        if (subjectData) {
            const newSubject = {
                id: subjects[0].id,
                name: subjectData.name,
                uv: subjectData.uv,
                year: subjectData.year,
                average: subjects[0].average || 0,
                approved: subjects[0].approved || false,
                current: subjects[0].current || true,
                times: subjects[0].times || 1,
                evaluations: subjects[0].evaluations || []
            };

            user.subjects.push(newSubject);
        }
    }
}

// Update the grade or delete an evaluation of a subject
async function updateOrDeleteEvaluation(user, evaluations) {
    if (!evaluations) {
        return;
    }

    evaluations.forEach((eval) => {
        const subject = user.subjects.find((subj) => subj.id === eval.subject_id);

        if (subject) {
            const evaluation = subject.evaluations.find((e) => e.id === eval.id);

            if (eval.delete) {
                subject.evaluations = subject.evaluations.filter((e) => e.id !== eval.id);
            } else if (evaluation) {
                if (eval.grade && eval.grade >= 0 && eval.grade <= 10) {
                    evaluation.grade = eval.grade;
                }

                subject.average = calculateAverage(subject.evaluations);
                subject.approved = subject.average >= 6;
            } else {
                const newEval = {
                    id: uuidv4(),
                    name: addEvaluationNameCounter(subject.evaluations.map((e) => e.name), eval.name),
                    percentage: eval.percentage,
                    grade: eval.grade || 0,
                    subject_id: eval.subject_id
                };

                subject.evaluations.push(newEval);
                subject.average = calculateAverage(subject.evaluations);
                subject.approved = subject.average >= 6;
            }
        }
    });
}

// Add a number to the new evaluation name
function addEvaluationNameCounter(evaluationNames, evaluationName) {
    let counter = 1;
    let newEvaluationName = `${evaluationName}-${counter}`;

    // Check if the name already exists
    while (evaluationNames.includes(newEvaluationName)) {
        newEvaluationName = `${evaluationName}-${counter}`;
        counter++;
    }

    return newEvaluationName;
}

async function updateUser(req, user) {
    if (req.body.password) {
        // Encrypt password
        const salt = await bcrypt.genSalt();
        // Update password
        user.password = await bcrypt.hash(req.body.password, salt);
    }

    if (req.body.role && validateRole(req.body.role)) {
        user.role = req.body.role;
    }

    return user;
}

// Delete an specific user
const usersDelete = async (req, res = response) => {
    const { id } = req.params;

    const userDB = await User.findByIdAndDelete(id);
    res.json({
        userDB,
    });
};

// Helper functions

// Validate role
const validateRole = (role) => {
    if (role == 'ADMIN_ROLE' || role == 'USER_ROLE')
        return true;
    else
        return false;
}

// Calculate subject average
const calculateAverage = (evaluations) => {
    let total = 0;

    evaluations.forEach((evaluation) => {
        total += evaluation.grade * evaluation.percentage;
    })

    // round total to 2 decimals
    total = (total / 100).toFixed(1);

    // limit total to 10
    if (total > 10) total = 10;

    return total;
}

// Calculate CUM
const calculateCum = (subjects) => {
    let cum = 0;
    let uv = 0;

    subjects.forEach((subject) => {
        if (subject.approved || !subject.current) {
            cum += subject.average * subject.uv;
            uv += subject.uv;
        }
    })

    // round total to 2 decimals
    cum = (cum / uv).toFixed(2);

    return cum;
}

module.exports = {
    usersGet,
    usersPost,
    usersPatch,
    usersDelete,
};
