source 'https://rubygems.org'
ruby '2.1.5'

gem 'volt', github: 'voltrb/volt', branch: 'master'
gem 'volt-bootstrap'
gem 'volt-fields'

# gem 'volt-user-templates'

# Server for MRI
platform :mri do
  gem 'thin', '~> 1.6.0'
  gem 'bson_ext', '~> 1.9.0'
end

# Server for jruby
platform :jruby do
  gem 'jubilee'
end

#---------------------
# Needed at the moment
gem 'volt-sockjs', require: false, platforms: :mri
